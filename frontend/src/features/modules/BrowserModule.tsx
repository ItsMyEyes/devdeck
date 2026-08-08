import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Globe,
  Loader2,
  Maximize2,
  Minimize2,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BrowserErrorPanel } from '@/features/browser/BrowserErrorPanel'
import type { BrowserLoadError } from '@/features/browser/browserLoadError'
import { BROWSER_LOAD_TIMEOUT_MS, httpLoadError, timeoutLoadError } from '@/features/browser/browserLoadError'
import { browserProxyUrl, fetchBrowserProxySession } from '@/lib/api'
import { cn } from '@/lib/utils'
import { ModuleHeader } from './ModuleHeader'

interface BrowserTab {
  id: string
  title: string
  url: string
  draft: string
  history: string[]
  historyIndex: number
  loading: boolean
  /** Set once a load fails or gives up; cleared when the next one starts. */
  error: BrowserLoadError | null
  reloadKey: number
}

interface BrowserBookmark {
  id: string
  title: string
  url: string
  group: string
}

/** 28px toolbar buttons are unhittable with a thumb, so they grow to 36px on
 *  touch pointers only — the row wraps, so the extra width is free. Mirrors
 *  `BrowserTile`'s own copy: the two browsers are separate surfaces and
 *  deliberately don't share styling (see `lib/browserTileBookmarks.ts`). */
const toolbarButtonClass = 'pointer-coarse:h-9 pointer-coarse:w-9'

const HOME_URL = 'https://example.com'
const SEARCH_URL = 'https://duckduckgo.com/?q='
const BOOKMARKS_STORAGE_KEY = 'devdeck.browser.bookmarks'
const HTTP_SCHEME = /^https?:\/\//i
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const HOST_LIKE = /^(\[[0-9a-f:]+\]|localhost|[\w-]+(\.[\w-]+)+|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i
const LOCAL_OR_PORT_HOST = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.0\.0\.0|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i
const DEFAULT_BOOKMARKS: BrowserBookmark[] = [
  { id: 'default-search', title: 'DuckDuckGo', url: 'https://duckduckgo.com', group: 'Search' },
  { id: 'default-github', title: 'GitHub', url: 'https://github.com', group: 'Code' },
  { id: 'default-docs', title: 'MDN Web Docs', url: 'https://developer.mozilla.org', group: 'Docs' },
]

function newTabId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function titleFor(url: string) {
  try {
    const parsed = new URL(url)
    const search = parsed.hostname.includes('duckduckgo.com') ? parsed.searchParams.get('q') : null
    if (search) return `Search: ${search}`
    return parsed.hostname.replace(/^www\./, '') || url
  } catch {
    return url
  }
}

function createTab(url = HOME_URL): BrowserTab {
  return {
    id: newTabId(),
    title: titleFor(url),
    url,
    draft: url,
    history: [url],
    historyIndex: 0,
    // A new tab starts loading the moment its frame gets a proxy token, so it
    // has to start in that state — otherwise the very first load of a tab is
    // the one load with no spinner and, more importantly, no timeout armed.
    loading: true,
    error: null,
    reloadKey: 0,
  }
}

function loadBookmarks(): BrowserBookmark[] {
  if (typeof window === 'undefined') return DEFAULT_BOOKMARKS
  try {
    const raw = window.localStorage.getItem(BOOKMARKS_STORAGE_KEY)
    if (!raw) return DEFAULT_BOOKMARKS
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return DEFAULT_BOOKMARKS
    const valid = parsed.filter(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        typeof item.title === 'string' &&
        typeof item.url === 'string' &&
        typeof item.group === 'string' &&
        HTTP_SCHEME.test(item.url),
    )
    return valid
  } catch {
    return DEFAULT_BOOKMARKS
  }
}

function groupedBookmarks(bookmarks: BrowserBookmark[]) {
  const groups = new Map<string, BrowserBookmark[]>()
  for (const bookmark of bookmarks) {
    const group = bookmark.group.trim() || 'Portal'
    groups.set(group, [...(groups.get(group) ?? []), bookmark])
  }
  return [...groups.entries()]
}

function normalizeAddress(value: string) {
  const raw = value.trim()
  if (!raw) return HOME_URL
  if (HTTP_SCHEME.test(raw)) return raw
  if (ANY_SCHEME.test(raw)) return SEARCH_URL + encodeURIComponent(raw)
  if (HOST_LIKE.test(raw)) {
    const hostPart = raw.split(/[/?#]/, 1)[0] ?? raw
    const scheme = LOCAL_OR_PORT_HOST.test(raw) || hostPart.includes(':') ? 'http' : 'https'
    return `${scheme}://${raw}`
  }
  return SEARCH_URL + encodeURIComponent(raw)
}

export function BrowserModule() {
  const [firstTab] = useState(() => createTab())
  const [tabs, setTabs] = useState<BrowserTab[]>([firstTab])
  const [activeId, setActiveId] = useState(firstTab.id)
  const [proxyToken, setProxyToken] = useState('')
  const [proxyError, setProxyError] = useState<string | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [bookmarks, setBookmarks] = useState<BrowserBookmark[]>(loadBookmarks)
  const [bookmarkGroup, setBookmarkGroup] = useState('Portal')
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [portalOpen, setPortalOpen] = useState(true)
  const [focusMode, setFocusMode] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]
  if (!active) return null

  const canGoBack = active.historyIndex > 0
  const canGoForward = active.historyIndex < active.history.length - 1
  const frameSrc = proxyToken ? `${browserProxyUrl(active.url, proxyToken)}&reload=${active.reloadKey}` : ''
  const bookmarkGroups = groupedBookmarks(bookmarks)

  useEffect(() => {
    let cancelled = false
    setProxyError(null)
    fetchBrowserProxySession()
      .then((session) => {
        if (!cancelled) setProxyToken(session.token)
      })
      .catch((err) => {
        if (cancelled) return
        setProxyError(err instanceof Error ? err.message : 'Could not start browser proxy')
        // No token means no frame, so no load will ever start or finish — and
        // the load timer below never arms without a `frameSrc` to arm it for.
        // Left alone, every tab keeps its opening spinner forever behind the
        // proxy-unavailable panel.
        setTabs((current) => current.map((tab) => ({ ...tab, loading: false })))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(bookmarks))
    } catch {
      // Bookmark persistence is a convenience; the browser itself still works.
    }
  }, [bookmarks])

  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(document.fullscreenElement === rootRef.current)
    }

    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return
      if (typeof event.data !== 'object' || event.data === null) return
      const data = event.data as { type?: unknown; url?: unknown; status?: unknown; error?: unknown }

      // The frame reporting what it actually got. An iframe cannot read its own
      // response headers, so this message is the only way the module learns
      // that the "page" it just rendered is a 404, or DevDeck's own proxy
      // failure page (see browserNavigationScript in browser_proxy.go).
      if (data.type === 'devdeck-browser:loaded') {
        const status = typeof data.status === 'number' ? data.status : 200
        const proxyMessage = typeof data.error === 'string' ? data.error : undefined
        updateTab(activeId, (tab) => ({
          ...tab,
          loading: false,
          error: status >= 400 ? httpLoadError(status, proxyMessage) : null,
        }))
        return
      }

      if (data.type !== 'devdeck-browser:navigate' || typeof data.url !== 'string' || !HTTP_SCHEME.test(data.url)) {
        return
      }
      const nextUrl = data.url
      setTabs((current) =>
        current.map((tab) => {
          if (tab.id !== activeId) return tab
          if (tab.url === nextUrl) {
            return { ...tab, title: titleFor(nextUrl), draft: nextUrl, loading: true, error: null }
          }
          const history = [...tab.history.slice(0, tab.historyIndex + 1), nextUrl]
          return {
            ...tab,
            title: titleFor(nextUrl),
            url: nextUrl,
            draft: nextUrl,
            history,
            historyIndex: history.length - 1,
            loading: true,
            error: null,
          }
        }),
      )
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [activeId])

  // Nothing else ever ends a load that simply never arrives: `onLoad` only
  // fires on success, and a request stuck behind a dead tunnel or a body that
  // never finishes leaves the frame blank and the tab spinning forever. Keyed
  // on the load's identity (tab, url, reload counter) so each navigation gets
  // its own timer, and torn down by the cleanup as soon as `loading` clears.
  useEffect(() => {
    if (!active.loading || !frameSrc) return
    const timer = window.setTimeout(() => {
      updateTab(active.id, (tab) => (tab.loading ? { ...tab, loading: false, error: timeoutLoadError() } : tab))
    }, BROWSER_LOAD_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [active.id, active.loading, active.url, active.reloadKey, frameSrc])

  function updateTab(tabId: string, patcher: (tab: BrowserTab) => BrowserTab) {
    setTabs((current) => current.map((tab) => (tab.id === tabId ? patcher(tab) : tab)))
  }

  function navigate(tabId: string, raw: string) {
    const url = normalizeAddress(raw)
    updateTab(tabId, (tab) => {
      const history = [...tab.history.slice(0, tab.historyIndex + 1), url]
      return {
        ...tab,
        title: titleFor(url),
        url,
        draft: url,
        history,
        historyIndex: history.length - 1,
        loading: true,
        error: null,
      }
    })
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    navigate(active.id, active.draft)
  }

  function setDraft(value: string) {
    updateTab(active.id, (tab) => ({ ...tab, draft: value }))
  }

  function goHistory(delta: -1 | 1) {
    updateTab(active.id, (tab) => {
      const nextIndex = tab.historyIndex + delta
      const url = tab.history[nextIndex]
      if (!url) return tab
      return {
        ...tab,
        title: titleFor(url),
        url,
        draft: url,
        historyIndex: nextIndex,
        loading: true,
        error: null,
      }
    })
  }

  /** Also the error panel's Retry — a failed load has nothing to recover but
   *  the request itself, and bumping `reloadKey` remounts the frame so a page
   *  that half-rendered before failing doesn't linger behind the next one. */
  function reload() {
    updateTab(active.id, (tab) => ({ ...tab, loading: true, error: null, reloadKey: tab.reloadKey + 1 }))
  }

  function addTab(url?: string) {
    const tab = createTab(url ?? HOME_URL)
    setTabs((current) => [...current, tab])
    setActiveId(tab.id)
  }

  function closeTab(tabId: string) {
    if (tabs.length === 1) {
      const tab = createTab()
      setTabs([tab])
      setActiveId(tab.id)
      return
    }
    const index = tabs.findIndex((tab) => tab.id === tabId)
    const nextTabs = tabs.filter((tab) => tab.id !== tabId)
    setTabs(nextTabs)
    if (activeId === tabId) {
      const nextActive = nextTabs[Math.max(0, index - 1)] ?? nextTabs[0]
      if (nextActive) setActiveId(nextActive.id)
    }
  }

  function addBookmark() {
    const group = bookmarkGroup.trim() || 'Portal'
    setBookmarks((current) => {
      const existing = current.find((bookmark) => bookmark.url === active.url && bookmark.group.toLowerCase() === group.toLowerCase())
      if (existing) {
        return current.map((bookmark) =>
          bookmark.id === existing.id ? { ...bookmark, title: titleFor(active.url), group } : bookmark,
        )
      }
      return [...current, { id: newTabId(), title: titleFor(active.url), url: active.url, group }]
    })
  }

  function removeBookmark(bookmarkId: string) {
    setBookmarks((current) => current.filter((bookmark) => bookmark.id !== bookmarkId))
  }

  function openBookmark(bookmark: BrowserBookmark, newTab: boolean) {
    if (newTab) {
      addTab(bookmark.url)
      return
    }
    navigate(active.id, bookmark.url)
  }

  async function toggleFullscreen() {
    const root = rootRef.current
    if (!root) return
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await root.requestFullscreen()
      }
    } catch {
      // Browsers can deny fullscreen when not triggered by a direct gesture.
    }
  }

  function openRealBrowser() {
    window.open(active.url, '_blank', 'noopener,noreferrer')
  }

  return (
    // `@container/browser` — the address row below reflows on this surface's own
    // width, so it degrades the same way whether it's narrow because the viewport
    // is a phone or because the module is sharing a split (see `BrowserTile`).
    <div ref={rootRef} className="@container/browser flex min-h-0 flex-1 flex-col bg-devdeck-pane">
      {!focusMode && (
        <>
          <ModuleHeader
            title="Browser"
            meta="sandboxed proxy, tabs, portal bookmarks"
            actions={
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setDetailsOpen((open) => !open)}
                  aria-expanded={detailsOpen}
                >
                  {detailsOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                  Details
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setFocusMode(true)}>
                  Focus
                </Button>
                <Button
                  size="icon-sm"
                  variant="secondary"
                  onClick={toggleFullscreen}
                  aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
                  title={isFullscreen ? 'Exit full screen' : 'Full screen'}
                >
                  {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
                </Button>
              </div>
            }
          />

          <div className="flex flex-none items-center gap-1 border-b border-devdeck-border bg-devdeck-pane px-2 py-1.5">
            <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
              {tabs.map((tab) => {
                const selected = tab.id === active.id
                return (
                  <div
                    key={tab.id}
                    className={cn(
                      'group/tab flex h-8 min-w-[150px] max-w-[240px] items-center rounded-lg border text-[12px]',
                      selected
                        ? 'border-devdeck-border-accent bg-devdeck-glass-solid text-devdeck-fg shadow-sm shadow-black/10'
                        : 'border-transparent bg-transparent text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveId(tab.id)}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-2 text-left"
                    >
                      {tab.loading ? <Loader2 size={12} className="flex-none animate-spin" /> : <Globe size={12} className="flex-none" />}
                      <span className="truncate">{tab.title}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => closeTab(tab.id)}
                      aria-label="Close tab"
                      className="mr-1 cursor-pointer rounded p-1 text-devdeck-fg-2 opacity-70 hover:bg-devdeck-glass-solid hover:text-devdeck-fg group-hover/tab:opacity-100"
                    >
                      <X size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
            <Button size="icon-sm" variant="secondary" onClick={() => addTab()} aria-label="New tab" title="New tab">
              <Plus size={13} />
            </Button>
          </div>

          {/* Wraps rather than crushing: the controls flanking the address bar are
              all fixed-width, so on a narrow surface the input was the only thing
              that could shrink. Below 32rem it takes its own full-width row. */}
          <form onSubmit={submit} className="flex flex-none flex-wrap items-center gap-1.5 border-b border-devdeck-border bg-devdeck-pane px-3 py-2">
            <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={() => goHistory(-1)} disabled={!canGoBack} aria-label="Back">
              <ArrowLeft size={13} />
            </Button>
            <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={() => goHistory(1)} disabled={!canGoForward} aria-label="Forward">
              <ArrowRight size={13} />
            </Button>
            <Button size="icon-sm" variant="secondary" className={toolbarButtonClass} onClick={reload} aria-label="Reload">
              <RefreshCw size={13} />
            </Button>
            <Input
              value={active.draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Search or enter URL"
              /* 16px on touch: below that, mobile Safari zooms the page on focus. */
              className="order-last h-8 w-full min-w-0 font-mono text-[12px] pointer-coarse:h-9 pointer-coarse:text-[16px] @lg/browser:order-none @lg/browser:w-auto @lg/browser:flex-1"
            />
            <Button size="sm" type="submit" className="pointer-coarse:h-9">
              Go
            </Button>
            <Button
              size="icon-sm"
              type="button"
              variant="secondary"
              className={toolbarButtonClass}
              onClick={addBookmark}
              aria-label={`Save bookmark to ${bookmarkGroup.trim() || 'Portal'}`}
              title={`Save to ${bookmarkGroup.trim() || 'Portal'}`}
            >
              <Star size={13} />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="ml-auto px-2 pointer-coarse:h-9 @lg/browser:ml-0 @lg/browser:px-2.5"
              onClick={openRealBrowser}
              aria-label="Open in your real browser"
              title="Open in your real browser"
            >
              <ExternalLink size={13} />
              {/* Label is the widest thing in the row — icon-only when space is tight. */}
              <span className="hidden @lg/browser:inline">Real browser</span>
            </Button>
          </form>

          {detailsOpen && (
            <div className="flex flex-none flex-col border-b border-devdeck-border bg-devdeck-pane">
              <div className="flex items-center gap-2 px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => setPortalOpen((open) => !open)}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-devdeck-fg-2 hover:bg-devdeck-glass-solid hover:text-devdeck-fg"
                  aria-expanded={portalOpen}
                >
                  <Bookmark size={13} />
                  Portal
                  <span className="rounded bg-devdeck-glass-solid px-1.5 py-0.5 font-mono text-[10px] text-devdeck-fg-2">{bookmarks.length}</span>
                </button>
                <div className="h-4 w-px bg-devdeck-border" />
                <label className="flex items-center gap-1.5 text-[11px] text-devdeck-fg-2">
                  Save group
                  <Input
                    value={bookmarkGroup}
                    onChange={(event) => setBookmarkGroup(event.target.value)}
                    placeholder="Portal"
                    className="h-7 w-28 rounded-md font-mono text-[11px]"
                  />
                </label>
                <div className="min-w-0 flex-1" />
                <span className="hidden text-[10.5px] text-devdeck-fg-2 md:inline">Click bookmark to open, hover for actions</span>
              </div>

              {portalOpen && (
                <div className="flex gap-2 overflow-x-auto px-3 pb-2">
                  {bookmarkGroups.map(([group, items]) => (
                    <div
                      key={group}
                      className="flex flex-none items-center gap-1.5 rounded-lg border border-devdeck-border-menu bg-devdeck-pane/40 px-2 py-1"
                    >
                      <span className="mr-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-devdeck-fg-2">{group}</span>
                      {items.map((bookmark) => (
                        <div
                          key={bookmark.id}
                          className="group/bookmark flex items-center rounded-full bg-devdeck-glass-solid ring-1 ring-transparent hover:ring-devdeck-border"
                        >
                          <button
                            type="button"
                            onClick={() => openBookmark(bookmark, false)}
                            className="max-w-[150px] cursor-pointer truncate px-2.5 py-1 text-left text-[11.5px] text-devdeck-fg-2 hover:text-devdeck-accent"
                            title={bookmark.url}
                          >
                            {bookmark.title}
                          </button>
                          <div className="flex max-w-0 overflow-hidden opacity-0 transition-all group-hover/bookmark:max-w-[48px] group-hover/bookmark:opacity-100">
                            <button
                              type="button"
                              onClick={() => openBookmark(bookmark, true)}
                              aria-label={`Open ${bookmark.title} in a new tab`}
                              className="cursor-pointer px-1 py-1 text-devdeck-fg-2 hover:text-devdeck-accent"
                            >
                              <Plus size={11} />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeBookmark(bookmark.id)}
                              aria-label={`Remove ${bookmark.title}`}
                              className="cursor-pointer px-1.5 py-1 text-devdeck-fg-2 hover:text-devdeck-err"
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div className={cn('relative min-h-0 flex-1 bg-devdeck-pane', focusMode ? 'p-0' : 'p-2')}>
        {focusMode && (
          <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setFocusMode(false)} className="bg-devdeck-pane/90 backdrop-blur">
              Show controls
            </Button>
            <Button
              size="icon-sm"
              variant="secondary"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? 'Exit full screen' : 'Enter full screen'}
              title={isFullscreen ? 'Exit full screen' : 'Full screen'}
              className="bg-devdeck-pane/90 backdrop-blur"
            >
              {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </Button>
          </div>
        )}
        {proxyError ? (
          <div className="flex h-full w-full items-center justify-center rounded-lg border border-devdeck-border bg-devdeck-pane text-[12px] text-devdeck-fg-2">
            Browser proxy unavailable: {proxyError}
          </div>
        ) : !frameSrc ? (
          <div className="flex h-full w-full items-center justify-center rounded-lg border border-devdeck-border bg-devdeck-pane text-[12px] text-devdeck-fg-2">
            Preparing browser proxy session…
          </div>
        ) : active.error ? (
          <BrowserErrorPanel
            error={active.error}
            url={active.url}
            onRetry={reload}
            className={cn('border border-devdeck-border', focusMode ? 'rounded-none border-0' : 'rounded-lg')}
          />
        ) : (
          <iframe
            ref={iframeRef}
            key={`${active.id}:${active.reloadKey}:${active.url}:${proxyToken}`}
            title={`Browser tab: ${active.title}`}
            src={frameSrc}
            sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
            referrerPolicy="no-referrer"
            onLoad={() => updateTab(active.id, (tab) => ({ ...tab, loading: false }))}
            className={cn('h-full w-full border border-devdeck-border bg-white', focusMode ? 'rounded-none border-0' : 'rounded-lg')}
          />
        )}
      </div>

      {!focusMode && detailsOpen && (
        <div className="flex flex-none items-center gap-2 border-t border-devdeck-border px-3 py-1.5 font-mono text-[10.5px] text-devdeck-fg-2">
          <span className="h-1.5 w-1.5 rounded-full bg-devdeck-fg-2" />
          <span>Requests leave from the DevDeck server network. Some sites with strict embed or bot protection may not render fully.</span>
        </div>
      )}
    </div>
  )
}

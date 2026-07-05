import type { FormEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, Loader2, Plus, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { browserProxyUrl } from '@/lib/api'
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
  reloadKey: number
}

const HOME_URL = 'https://example.com'
const SEARCH_URL = 'https://duckduckgo.com/?q='
const HTTP_SCHEME = /^https?:\/\//i
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const HOST_LIKE = /^(\[[0-9a-f:]+\]|localhost|[\w-]+(\.[\w-]+)+|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i
const LOCAL_OR_PORT_HOST = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.0\.0\.0|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#].*)?$/i

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
    loading: false,
    reloadKey: 0,
  }
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
  const iframeRef = useRef<HTMLIFrameElement>(null)

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]
  if (!active) return null

  const canGoBack = active.historyIndex > 0
  const canGoForward = active.historyIndex < active.history.length - 1
  const frameSrc = `${browserProxyUrl(active.url)}&reload=${active.reloadKey}`

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return
      if (typeof event.data !== 'object' || event.data === null) return
      const data = event.data as { type?: unknown; url?: unknown }
      if (data.type !== 'loom-browser:navigate' || typeof data.url !== 'string' || !HTTP_SCHEME.test(data.url)) {
        return
      }
      const nextUrl = data.url
      setTabs((current) =>
        current.map((tab) => {
          if (tab.id !== activeId) return tab
          if (tab.url === nextUrl) {
            return { ...tab, title: titleFor(nextUrl), draft: nextUrl, loading: true }
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
          }
        }),
      )
    }

    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [activeId])

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
      }
    })
  }

  function reload() {
    updateTab(active.id, (tab) => ({ ...tab, loading: true, reloadKey: tab.reloadKey + 1 }))
  }

  function addTab() {
    const tab = createTab()
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ModuleHeader
        title="Browser"
        meta="server-network proxy · sandboxed tabs"
        actions={
          <Button size="sm" variant="secondary" onClick={addTab}>
            <Plus size={13} />
            New tab
          </Button>
        }
      />

      <div className="flex flex-none gap-1 overflow-x-auto border-b border-loom-border bg-loom-surface px-2 py-1.5">
        {tabs.map((tab) => {
          const selected = tab.id === active.id
          return (
            <div
              key={tab.id}
              className={cn(
                'flex h-8 min-w-[150px] max-w-[240px] items-center rounded-lg border text-[12px]',
                selected
                  ? 'border-loom-border-accent bg-loom-card text-loom-fg'
                  : 'border-transparent bg-transparent text-loom-muted hover:bg-loom-hover-wash hover:text-loom-fg',
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
                className="mr-1 cursor-pointer rounded p-1 text-loom-muted-2 hover:bg-loom-popover hover:text-loom-fg"
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>

      <form onSubmit={submit} className="flex flex-none items-center gap-1.5 border-b border-loom-border px-3 py-2">
        <Button size="icon-sm" variant="secondary" onClick={() => goHistory(-1)} disabled={!canGoBack} aria-label="Back">
          <ArrowLeft size={13} />
        </Button>
        <Button size="icon-sm" variant="secondary" onClick={() => goHistory(1)} disabled={!canGoForward} aria-label="Forward">
          <ArrowRight size={13} />
        </Button>
        <Button size="icon-sm" variant="secondary" onClick={reload} aria-label="Reload">
          <RefreshCw size={13} />
        </Button>
        <Input
          value={active.draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Search or enter URL"
          className="h-8 flex-1 font-mono text-[12px]"
        />
        <Button size="sm" type="submit">
          Go
        </Button>
      </form>

      <div className="min-h-0 flex-1 bg-loom-terminal p-2">
        <iframe
          ref={iframeRef}
          key={`${active.id}:${active.reloadKey}:${active.url}`}
          title={`Browser tab: ${active.title}`}
          src={frameSrc}
          sandbox="allow-downloads allow-forms allow-modals allow-popups allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={() => updateTab(active.id, (tab) => ({ ...tab, loading: false }))}
          className="h-full w-full rounded-lg border border-loom-border bg-white"
        />
      </div>

      <div className="flex flex-none items-center gap-2 border-t border-loom-border px-3 py-1.5 font-mono text-[10.5px] text-loom-dim">
        <span className="h-1.5 w-1.5 rounded-full bg-loom-accent" />
        <span>Requests leave from the Loom server network. Some sites with strict embed or bot protection may not render fully.</span>
      </div>
    </div>
  )
}

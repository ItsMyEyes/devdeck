// Why a Browser surface stopped waiting on a page load, and how it says so.
//
// Both browsers need this: the web module renders /api/browser/proxy in a
// sandboxed iframe, the desktop tile renders a native webview through a
// machine's forward proxy. Neither one could previously tell "still loading"
// from "never going to load" — an iframe only ever fires `load`, and the
// native tile only hears `on_page_load`, so a stalled request left the spinner
// turning forever. The two surfaces keep their own panels and their own
// styling (see BrowserModule's `toolbarButtonClass` note), but they agree on
// what counts as a failed load and what to call it.

export type BrowserLoadErrorKind =
  /** No committed load within BROWSER_LOAD_TIMEOUT_MS. */
  | 'timeout'
  /** The site itself answered >=400. */
  | 'http'
  /** DevDeck's own proxy could not complete the request. */
  | 'proxy'

export interface BrowserLoadError {
  kind: BrowserLoadErrorKind
  /** Upstream HTTP status. Absent for 'timeout' — nothing ever answered. */
  status?: number
  title: string
  detail: string
}

/** How long a surface waits for a load to commit before giving up.
 *
 *  Deliberately longer than the proxy's own 20s `ResponseHeaderTimeout`
 *  (`browser_proxy.go`): when the server-side timeout is the one that trips,
 *  it reports a real 504 with a reason, which beats this timer's generic
 *  message. This is the backstop for everything the server can't report —
 *  a dead tunnel, a hung native webview, a response whose body never ends. */
export const BROWSER_LOAD_TIMEOUT_MS = 30_000

const HTTP_STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  410: 'Gone',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
}

export function httpStatusLabel(status: number): string {
  const text = HTTP_STATUS_TEXT[status]
  if (text) return `${status} ${text}`
  if (status >= 500) return `${status} Server Error`
  return `${status} Client Error`
}

export function timeoutLoadError(timeoutMs = BROWSER_LOAD_TIMEOUT_MS): BrowserLoadError {
  return {
    kind: 'timeout',
    title: 'This page took too long to load',
    detail: `Nothing arrived after ${Math.round(timeoutMs / 1000)} seconds. The site may be slow, or unreachable from the network the request leaves through.`,
  }
}

/** Builds the panel copy for a load that finished with a >=400 status.
 *
 *  `proxyMessage` is set only when the failure was DevDeck's own — the proxy
 *  renders its error as a page carrying its message (see
 *  `browserProxyErrorDocument` in `browser_proxy.go`), so the panel can say
 *  "the proxy couldn't reach it" instead of blaming the site. */
export function httpLoadError(status: number, proxyMessage?: string): BrowserLoadError {
  if (proxyMessage) {
    return {
      kind: 'proxy',
      status,
      title: "DevDeck couldn't load this page",
      detail: `${sentence(proxyMessage)} (${httpStatusLabel(status)})`,
    }
  }
  return {
    kind: 'http',
    status,
    title: "This page didn't load",
    detail: `The site responded with ${httpStatusLabel(status)}.`,
  }
}

function sentence(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) return ''
  const capitalized = trimmed[0].toUpperCase() + trimmed.slice(1)
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`
}

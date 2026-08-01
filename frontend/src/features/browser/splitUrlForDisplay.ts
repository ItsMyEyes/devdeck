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

/** The active tab pill's label (design spec §3.3): scheme and a single bare
 *  trailing slash stripped — e.g. `https://example.com/dashboard/` becomes
 *  `example.com/dashboard`, but `https://example.com/` (nothing but the
 *  root slash) becomes just `example.com`. Falls back to the raw string for
 *  anything that doesn't parse as a URL (a blank `New Tab`, or a value
 *  still mid-typing in the URL card). */
export function displayUrl(url: string): string {
  if (!url) return 'New Tab'
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
    return `${parsed.hostname}${path}${parsed.search}`
  } catch {
    return url
  }
}

/** A runtime's hub connection details, as generated into `copy-this.md` by
 *  the install script (see
 *  docs/superpowers/specs/2026-07-16-runtime-bootstrap-installer-design.md). */
export interface ParsedConnection {
  name: string
  url: string
  key: string
}

/** Parses a `name|url|key` connection string pasted from a runtime's
 *  copy-this.md. Returns null unless there are exactly 3 non-empty
 *  pipe-delimited fields and the url is absolute http(s) — the same
 *  validation `validMachineURL` applies server-side in PostMachine. */
export function parseConnectionString(raw: string): ParsedConnection | null {
  const parts = raw
    .trim()
    .split('|')
    .map((p) => p.trim())
  if (parts.length !== 3 || parts.some((p) => p.length === 0)) return null
  const [name, url, key] = parts
  if (!/^https?:\/\//.test(url)) return null
  return { name, url, key }
}

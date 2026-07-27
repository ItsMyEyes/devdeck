/** Reads the download filename out of a `Content-Disposition` response header.
 *
 *  Needed because the DB export endpoint streams a file rather than JSON, so
 *  the SPA has to name the Blob itself. The Go side
 *  (backend/internal/handler/content_disposition.go) emits both parameters:
 *  `filename=` is a lossy ASCII quoted-string (every non-ASCII byte becomes
 *  "_") and `filename*=` is the exact name RFC 5987-encoded. RFC 6266 §4.3
 *  says a client that understands the extended form must prefer it, which is
 *  what keeps a non-ASCII table name intact in the saved file.
 *
 *  Pure — see `npx tsx src/lib/contentDisposition.test.ts`.
 */

/** Strips any directory component and surrounding whitespace. The header is
 *  server-controlled, but a name like `../../etc/passwd` reaching the browser's
 *  download path is worth not forwarding; `a.download` already refuses to
 *  traverse, so this is belt-and-braces plus tidier output. */
function sanitize(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  return base.trim()
}

export function parseContentDispositionFilename(header: string | null, fallback: string): string {
  if (!header) return fallback

  // Extended form first: filename*=UTF-8''pct-encoded (the language field
  // between the quotes is optional and ignored). Runs to the next `;` or the
  // end of the header — RFC 8187's attr-char set excludes both.
  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]*)/i.exec(header)
  if (extended) {
    try {
      const decoded = sanitize(decodeURIComponent(extended[1].trim()))
      if (decoded) return decoded
    } catch {
      // A malformed escape (a lone "%") makes decodeURIComponent throw; fall
      // through to the plain parameter rather than failing the download.
    }
  }

  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header)
  if (quoted) {
    const unescaped = sanitize(quoted[1].replace(/\\(.)/g, '$1'))
    if (unescaped) return unescaped
  }

  const token = /filename\s*=\s*([^;"]+)/i.exec(header)
  if (token) {
    const trimmed = sanitize(token[1])
    if (trimmed) return trimmed
  }

  return fallback
}

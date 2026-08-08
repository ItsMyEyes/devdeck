import { useEffect, useState } from 'react'
import { ExternalLink } from 'lucide-react'

/**
 * PDFs render through the browser's own viewer rather than a bundled one.
 *
 * Chromium, Firefox, Safari and macOS WKWebView (which is what the Tauri
 * shell runs) all ship a PDF viewer with search, zoom, print and text
 * selection already built. Shipping pdf.js to reimplement that would add
 * roughly a megabyte to the bundle to end up with less.
 *
 * The escape hatch matters though: WebKitGTK — Linux Tauri — has no PDF
 * support at all, and `<object>` silently renders nothing there. So the
 * fallback content is a real "open in a new tab" affordance rather than a
 * dead end.
 */
export function PdfView({ bytes, name }: { bytes: Uint8Array; name: string }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    // Copy via `slice()`: `bytes` may be a view onto a larger buffer, and Blob
    // would otherwise keep the whole thing alive for the life of the URL.
    const objectUrl = URL.createObjectURL(new Blob([bytes.slice()], { type: 'application/pdf' }))
    setUrl(objectUrl)
    return () => {
      URL.revokeObjectURL(objectUrl)
      setUrl(null)
    }
  }, [bytes])

  if (!url) return null

  return (
    <object data={url} type="application/pdf" className="min-h-0 flex-1" aria-label={name}>
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <span className="max-w-md font-mono text-[11px] leading-relaxed text-devdeck-fg-2">
          This browser has no built-in PDF viewer.
        </span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 rounded border border-devdeck-border-strong bg-devdeck-glass-solid px-3 py-1.5 text-[11px] text-devdeck-fg-2 hover:border-devdeck-border-accent hover:text-devdeck-accent"
        >
          <ExternalLink size={12} />
          Open {name} in a new tab
        </a>
      </div>
    </object>
  )
}

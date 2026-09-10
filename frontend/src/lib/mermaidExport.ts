import { currentResolvedTheme } from '@/features/theme/theme'

/** Matches a fenced ```mermaid block and its content, non-greedily so a
 *  document with several diagrams splits at each one's own closing fence
 *  rather than swallowing everything up to the last. Mirrors the shape
 *  MarkdownPreview/MermaidBlock already treat as a diagram. */
const MERMAID_FENCE = /```mermaid[ \t]*\r?\n([\s\S]*?)\r?\n```/g

/**
 * Rasterizes every ```mermaid fenced block in `markdown` to a PNG (via the
 * real mermaid renderer already used for the live preview/editor canvas —
 * see MermaidDiagram.tsx) and replaces each fence with an embedded
 * `data:image/png` image, before the markdown is sent to the backend's
 * markdown -> docx/pdf export endpoint.
 *
 * The export endpoint has its own from-scratch, pure-Go mermaid renderer
 * (no Node/Chromium available server-side), which only understands a narrow
 * flowchart/sequence-diagram subset — anything else silently degrades to a
 * labeled code block showing the raw source, which is what "mermaid doesn't
 * load on export" actually was. Rendering here first, with the same library
 * every diagram already renders through, means an export matches whatever
 * the user already sees on screen regardless of diagram type.
 *
 * A diagram that fails to render (a genuine syntax error) is left as its
 * original fence, so the backend's own fallback still applies rather than
 * silently dropping the block.
 */
export async function prerenderMermaidForExport(markdown: string): Promise<string> {
  const matches = [...markdown.matchAll(MERMAID_FENCE)]
  if (matches.length === 0) return markdown

  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({
    startOnLoad: false,
    theme: currentResolvedTheme() === 'light' ? 'default' : 'dark',
    securityLevel: 'strict',
  })

  let result = ''
  let cursor = 0
  for (const match of matches) {
    const start = match.index ?? 0
    result += markdown.slice(cursor, start)
    const chart = match[1]
    const dataUrl = await renderMermaidToPngDataUrl(mermaid, chart)
    result += dataUrl ? `![diagram](${dataUrl})` : match[0]
    cursor = start + match[0].length
  }
  result += markdown.slice(cursor)
  return result
}

async function renderMermaidToPngDataUrl(
  mermaid: typeof import('mermaid').default,
  chart: string,
): Promise<string | null> {
  const id = `mermaid-export-${crypto.randomUUID().replace(/-/g, '')}`
  try {
    const { svg } = await mermaid.render(id, chart)
    return await svgToPngDataUrl(svg)
  } catch {
    // mermaid measures in an off-screen node named after the render id and
    // only cleans it up on success — see MermaidDiagram.tsx's identical note.
    document.getElementById(`d${id}`)?.remove()
    return null
  }
}

/** Rasterizes an SVG string to a PNG data URL via an off-screen canvas, at
 *  2x scale so text stays crisp in a printed PDF/Word page. PNG rather than
 *  the SVG directly: the backend's data-url image path decodes with Go's
 *  stdlib `image` package, which has no SVG decoder. */
function svgToPngDataUrl(svg: string, scale = 2): Promise<string> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('canvas 2d context unavailable')
        // Word/PDF have no notion of the diagram's transparent background,
        // so an unfilled canvas would print as black.
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/png'))
      } catch (err) {
        reject(err instanceof Error ? err : new Error('failed to rasterize svg'))
      } finally {
        URL.revokeObjectURL(url)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('failed to load svg for rasterization'))
    }
    img.src = url
  })
}

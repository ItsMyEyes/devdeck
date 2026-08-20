import { useEffect, useId, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { currentResolvedTheme } from '@/features/theme/theme'

/** How long the source has to hold still before the diagram re-renders.
 *  On the editing canvas `chart` changes on every keystroke, and mermaid's
 *  parse + layout is far too expensive to run on each one — worse, a
 *  half-typed line is a syntax error, so an undebounced render would flash
 *  parser errors at someone who is simply still typing. Only *changes* wait:
 *  the first render is immediate, so a document opens with its diagrams
 *  already on screen. */
const RERENDER_DELAY_MS = 300

/**
 * Renders one mermaid source string to an inline SVG via mermaid's browser
 * render API — shared by both markdown surfaces, so a diagram looks the same
 * in the Tiptap canvas (`MermaidBlock`) as in the rendered preview
 * (`MarkdownPreview`).
 *
 * mermaid is lazy-imported: it is one of the largest dependencies in the app
 * and most documents never contain a diagram, so it must not sit in the eager
 * chunk of every surface that can display markdown.
 */
export function MermaidDiagram({ chart, className }: { chart: string; className?: string }) {
  // mermaid renders into a DOM id it derives from this, so it has to be unique
  // per instance — two diagrams in one document would otherwise collide.
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rendered = useRef(false)

  useEffect(() => {
    if (!chart.trim()) {
      setSvg(null)
      setError(null)
      return
    }
    let cancelled = false
    const id = `mermaid-${reactId}`
    const timer = setTimeout(
      () => {
        import('mermaid')
          .then(async ({ default: mermaid }) => {
            mermaid.initialize({
              startOnLoad: false,
              theme: currentResolvedTheme() === 'light' ? 'default' : 'dark',
              securityLevel: 'strict',
            })
            const result = await mermaid.render(id, chart)
            if (cancelled) return
            rendered.current = true
            setSvg(result.svg)
            setError(null)
          })
          .catch((err: unknown) => {
            // mermaid measures in an off-screen node named after the render id
            // and only cleans it up on success. On the editing canvas a failed
            // render happens on the way to nearly every valid diagram, so
            // without this the document accumulates one orphan per typo.
            document.getElementById(`d${id}`)?.remove()
            if (cancelled) return
            rendered.current = true
            setError(err instanceof Error ? err.message : 'Could not render diagram')
          })
      },
      rendered.current ? RERENDER_DELAY_MS : 0,
    )
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [chart, reactId])

  if (error) {
    return (
      <pre className="overflow-x-auto rounded-md border border-devdeck-err/40 bg-devdeck-red-tint px-3 py-2 font-mono text-[11px] text-devdeck-err">
        {error}
      </pre>
    )
  }
  if (!svg) {
    return <div className="font-mono text-[11px] text-notion-text-dim">Rendering diagram…</div>
  }
  return (
    <div
      // mermaid renders a `display: block` svg carrying its own inline
      // max-width, so it needs auto margins to centre — `text-align` on an
      // ancestor does nothing to it. The max-width cap is what keeps a diagram
      // wider than the page inside its own scroll area instead of widening it.
      className={cn(
        'devdeck-mermaid max-w-full overflow-x-auto [&_svg]:mx-auto [&_svg]:max-w-full',
        className,
      )}
      // mermaid's `strict` security level sanitizes the rendered markup itself.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

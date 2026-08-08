import { isValidElement, useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

/** Renders one ```mermaid fenced block to an inline SVG via mermaid's
 *  browser render API. Lazy-imported (mermaid is a large dependency most
 *  previews never touch) and re-rendered whenever `chart` changes — cheap
 *  enough for prose-sized diagrams and simpler than diffing the source. */
function MermaidDiagram({ chart }: { chart: string }) {
  const reactId = useId().replace(/[^a-zA-Z0-9]/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSvg(null)
    setError(null)
    import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })
      try {
        const result = await mermaid.render(`mermaid-${reactId}`, chart)
        if (!cancelled) setSvg(result.svg)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not render diagram')
      }
    })
    return () => {
      cancelled = true
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
    return <div className="font-mono text-[11px] text-devdeck-fg-2">Rendering diagram…</div>
  }
  return (
    <div
      className="devdeck-mermaid max-w-full overflow-x-auto [&_svg]:max-w-full"
      // mermaid's `strict` security level sanitizes the rendered markup itself.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}

function codeLanguage(className: string | undefined): string | undefined {
  return /language-(\S+)/.exec(className ?? '')?.[1]
}

/** Detects a `pre > code.language-mermaid` fenced block by shape, since
 *  react-markdown gives `pre` its already-rendered `code` child rather than
 *  the raw node. Used to skip the `<pre>` wrapper for a mermaid diagram —
 *  wrapping a rendered SVG in a monospace/whitespace-preserving `<pre>`
 *  would fight the diagram's own layout. */
function isMermaidCodeElement(node: ReactNode): boolean {
  return isValidElement<{ className?: string }>(node) && codeLanguage(node.props.className) === 'mermaid'
}

const components: Components = {
  // `node` (react-markdown's `ExtraProps`) isn't a valid DOM attribute —
  // dropped here rather than spread onto the native element below.
  code({ className, children, node: _node, ...props }) {
    const language = codeLanguage(className)
    if (language === 'mermaid') {
      return <MermaidDiagram chart={String(children).replace(/\n$/, '')} />
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  },
  pre({ children, node: _node, ...props }) {
    const child = Array.isArray(children) ? children[0] : children
    if (isMermaidCodeElement(child)) return <>{children}</>
    return <pre {...props}>{children}</pre>
  },
}

/** Read-only markdown rendering with DevDeck's typography tokens. Fenced
 *  ```mermaid blocks render as diagrams instead of code text. */
export function MarkdownPreview({ source }: { source: string }) {
  if (!source.trim()) {
    return <p className="font-mono text-[12px] text-devdeck-fg-2">Nothing to preview.</p>
  }
  return (
    <div className="devdeck-markdown flex flex-col gap-2.5 text-[13px] leading-relaxed text-devdeck-fg-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  )
}

import { isValidElement } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { MermaidDiagram } from '@/features/rich-editor/MermaidDiagram'
import { cn } from '@/lib/utils'

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

/**
 * Read-only markdown rendering on the same Notion theme the editor writes in
 * (`.notion-doc`, globals.css), so a comment or a file reads identically
 * whether it is being edited or displayed. Fenced ```mermaid blocks render as
 * diagrams instead of code text.
 *
 * `compact` is the one-class size step down for markdown displayed inside
 * something else — a comment in a thread — as opposed to a page of its own.
 */
export function MarkdownPreview({ source, compact }: { source: string; compact?: boolean }) {
  if (!source.trim()) {
    return <p className="font-mono text-[12px] text-notion-text-dim">Nothing to preview.</p>
  }
  return (
    <div className={cn('notion-doc', compact && 'notion-doc--compact')}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  )
}

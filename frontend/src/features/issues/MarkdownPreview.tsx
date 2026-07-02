import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Read-only markdown rendering with Loom's typography tokens. */
export function MarkdownPreview({ source }: { source: string }) {
  if (!source.trim()) {
    return <p className="font-mono text-[12px] text-loom-dim">Nothing to preview.</p>
  }
  return (
    <div className="loom-markdown flex flex-col gap-2.5 text-[13px] leading-relaxed text-loom-fg-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  )
}

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Read-only markdown rendering with DevDeck's typography tokens. */
export function MarkdownPreview({ source }: { source: string }) {
  if (!source.trim()) {
    return <p className="font-mono text-[12px] text-devdeck-dim">Nothing to preview.</p>
  }
  return (
    <div className="devdeck-markdown flex flex-col gap-2.5 text-[13px] leading-relaxed text-devdeck-fg-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  )
}

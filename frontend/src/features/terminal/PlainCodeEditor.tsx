import { MonacoEditor } from '@/features/editor/MonacoEditor'
import type { LineReveal } from '@/features/editor/reveal'

export type { LineReveal }

/**
 * The editor for files with no language server: SSH files and untitled
 * buffers. Identical to CodeFileEditor minus everything LSP-specific — no
 * go-to-definition, no rename, no diagnostics. Monaco still supplies syntax
 * highlighting from its monarch tokenizers and word-based suggestions from
 * the open buffer.
 */
export function PlainCodeEditor({
  path,
  value,
  onChange,
  ready = true,
  reveal,
}: {
  path: string
  value: string
  onChange: (value: string) => void
  ready?: boolean
  /** Content search's "open at line" entry point. */
  reveal?: LineReveal
}) {
  return (
    <MonacoEditor
      path={path}
      value={value}
      ready={ready}
      reveal={reveal}
      onChange={onChange}
      ariaLabel={`Edit ${path}`}
      options={{ quickSuggestions: { other: true, comments: false, strings: false } }}
      className="h-full min-h-0 flex-1"
    />
  )
}

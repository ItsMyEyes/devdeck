import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { Code2, ExternalLink, Type } from 'lucide-react'
import { MonacoEditor } from '@/features/editor/MonacoEditor'
import type { LineReveal } from '@/features/editor/reveal'
import { DocumentOutline } from '@/features/rich-editor/DocumentOutline'
import { NotionEditor } from '@/features/rich-editor/NotionEditor'
import { joinFrontmatter, splitFrontmatter } from '@/features/rich-editor/frontmatter'
import {
  containsRawHtml,
  stripTrailingNewlines,
  trailingNewlines,
} from '@/features/rich-editor/markdownFile'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type Mode = 'rich' | 'raw'

function ModeButton({
  active,
  label,
  icon: Icon,
  onClick,
}: {
  active: boolean
  label: string
  icon: typeof Type
  onClick: () => void
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm transition-colors',
          active
            ? 'bg-notion-hover text-notion-text-strong'
            : 'text-notion-text-dim hover:bg-notion-hover hover:text-notion-text',
        )}
      >
        <Icon size={13} />
      </button>
    </Tooltip>
  )
}

/**
 * Markdown file editor. Opens as a Notion-style WYSIWYG document — formatting
 * through the selection toolbar and the "/" block menu, no raw syntax on
 * screen — with a toggle to a raw Monaco buffer.
 *
 * Raw mode is not a nicety. `getMarkdown()` re-serializes the whole document,
 * so a WYSIWYG edit normalizes the *entire* file (`*` bullets become `-`,
 * blank lines settle to the serializer's spacing). For a file on disk under
 * version control that has to be escapable, and it's also the only way to
 * reach syntax the editor has no node for. Frontmatter is the one such case
 * handled automatically: it's split off before parsing and re-attached
 * verbatim on the way out, so the WYSIWYG canvas can never rewrite it (see
 * `rich-editor/frontmatter.ts`).
 */
export function MarkdownFileEditor({
  path,
  value,
  ready = true,
  onChange,
  reveal,
  onOpenPreviewTab,
}: {
  path: string
  value: string
  /** True once `value` is the file's real, loaded content — see
   *  CodeFileEditor.tsx's reveal effect for why the reveal below must gate
   *  on load-completion rather than on `value` itself. Defaults to `true`
   *  for callers with no async load. */
  ready?: boolean
  onChange: (value: string) => void
  /** Content search's "open at line" entry point — see reveal.ts's
   *  LineReveal doc comment. Forces raw mode open: a line/column reveal only
   *  means something in the Monaco buffer, never on a rendered document. */
  reveal?: LineReveal
  /** "Open preview in new tab" button — opens `path`'s rendered preview as
   *  its own read-only tab. Omitted by callers with no tab strip to open it
   *  into (the button itself is hidden in that case). */
  onOpenPreviewTab?: (path: string) => void
}) {
  const [mode, setMode] = useState<Mode>('rich')
  /** The scrolling page, for the outline rail: it measures the current heading
   *  against this box and scrolls it when a dash is clicked. */
  const scrollRef = useRef<HTMLDivElement>(null)
  /** Handed out by NotionEditor once it exists — the rail is a sibling of the
   *  scroller rather than a child of the editor, so it can't reach it itself. */
  const [editor, setEditor] = useState<Editor | null>(null)

  useEffect(() => {
    if (reveal) setMode('raw')
  }, [reveal])

  const { frontmatter, body } = useMemo(() => splitFrontmatter(value), [value])

  // Raw HTML would be silently dropped by the first WYSIWYG edit, so a file
  // that has any opens in raw mode. Decided once, off the loaded content:
  // re-running it as the user types would yank the mode out from under them
  // the moment they deleted the last tag.
  const htmlChecked = useRef(false)
  useEffect(() => {
    if (!ready || htmlChecked.current) return
    htmlChecked.current = true
    if (containsRawHtml(body)) setMode('raw')
  }, [ready, body])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-none items-center gap-0.5 border-b border-notion-border bg-notion-bg px-2 py-1.5">
        <ModeButton
          active={mode === 'rich'}
          label="Rich text"
          icon={Type}
          onClick={() => setMode('rich')}
        />
        <ModeButton
          active={mode === 'raw'}
          label="Raw markdown"
          icon={Code2}
          onClick={() => setMode('raw')}
        />
        {onOpenPreviewTab ? (
          <>
            <span className="mx-0.5 h-4 w-px bg-notion-divider" />
            <Tooltip label="Open preview in new tab">
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onOpenPreviewTab(path)}
                aria-label="Open preview in new tab"
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm text-notion-text-dim transition-colors hover:bg-notion-hover hover:text-notion-text"
              >
                <ExternalLink size={13} />
              </button>
            </Tooltip>
          </>
        ) : null}
      </div>

      {mode === 'rich' ? (
        // The document fills the pane — no centred column cap — with the air
        // above the first line that a document gets and a form field doesn't.
        // The padding ladder is what makes it work at every pane width: it has
        // to clear the ~52px gutter the block controls live in on the left
        // (they appear at `sm`) and the ~60px the outline rail occupies on the
        // right (it appears at `md`), so text never runs under either.
        //
        // `relative` on the wrapper rather than on the scroller: the outline
        // rail has to stay put while the document scrolls under it.
        <div className="relative min-h-0 flex-1">
          <div ref={scrollRef} className="h-full overflow-auto bg-notion-bg">
            <div className="flex w-full flex-col gap-4 px-5 py-12 sm:px-14 md:px-16 xl:px-24">
              {frontmatter ? (
                <pre
                  title="Frontmatter is preserved as-is — switch to raw markdown to edit it"
                  className="overflow-x-auto rounded-sm bg-notion-surface px-4 py-3 font-mono text-[12px] leading-relaxed text-notion-text-dim"
                >
                  {frontmatter.trimEnd()}
                </pre>
              ) : null}
              <NotionEditor
                value={stripTrailingNewlines(body)}
                ready={ready}
                onChange={(nextBody) =>
                  onChange(joinFrontmatter(frontmatter, nextBody + trailingNewlines(body)))
                }
                ariaLabel={`Edit ${path}`}
                placeholder="Start writing, or press '/' for commands…"
                contentClassName="min-h-[60vh]"
                blockControls
                onEditorReady={setEditor}
              />
            </div>
          </div>
          <DocumentOutline editor={editor} scrollRef={scrollRef} />
        </div>
      ) : (
        <MonacoEditor
          path={path}
          value={value}
          ready={ready}
          reveal={reveal}
          onChange={onChange}
          language="markdown"
          ariaLabel={`Edit ${path} as markdown`}
          options={{ wordWrap: 'on', lineNumbers: 'off', quickSuggestions: false }}
          className="h-full min-h-0 flex-1"
        />
      )}
    </div>
  )
}

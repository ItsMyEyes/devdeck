import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { Code2, Download, ExternalLink, Loader2, Search, Type } from 'lucide-react'
import { toast } from 'sonner'
import { MonacoEditor } from '@/features/editor/MonacoEditor'
import type { LineReveal } from '@/features/editor/reveal'
import { FindBar } from '@/features/find/FindBar'
import { useDomFind } from '@/features/find/useDomFind'
import { useSelectAllScope } from '@/features/find/selectAllScope'
import { useCommandChordLabel } from '@/features/keybindings/store'
import { DocumentOutline } from '@/features/rich-editor/DocumentOutline'
import { NotionEditor } from '@/features/rich-editor/NotionEditor'
import { joinFrontmatter, splitFrontmatter } from '@/features/rich-editor/frontmatter'
import {
  containsRawHtml,
  stripTrailingNewlines,
  trailingNewlines,
} from '@/features/rich-editor/markdownFile'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import { Tooltip } from '@/components/ui/tooltip'
import { ApiError, exportMarkdown, type MarkdownExportFormat } from '@/lib/api'
import { pickSaveTarget, SAVE_CANCELLED } from '@/lib/saveFile'
import { cn } from '@/lib/utils'

type Mode = 'rich' | 'raw'

/** Base filename (no extension) an export dialog should suggest for `path`. */
function exportFilenameBase(path: string) {
  const base = path.split('/').pop() ?? 'document'
  return base.replace(/\.mdx?$/i, '') || 'document'
}

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
  /** The rich-mode pane, and the scope both the find bar and Select All are
   *  claimed inside. Wider than `scrollRef` so the bar, which is a sibling of
   *  the scroller, still counts as "inside the document" for the chord. */
  const richRef = useRef<HTMLDivElement>(null)
  /** Handed out by NotionEditor once it exists — the rail is a sibling of the
   *  scroller rather than a child of the editor, so it can't reach it itself. */
  const [editor, setEditor] = useState<Editor | null>(null)

  useEffect(() => {
    if (reveal) setMode('raw')
  }, [reveal])

  // Raw mode is Monaco, which brings its own find widget and select-all — so
  // both of these are bound only while the WYSIWYG canvas is the one on
  // screen, and Cmd+F keeps meaning the same thing in either mode.
  const find = useDomFind(scrollRef, { enabled: mode === 'rich', scopeRef: richRef, revision: value })

  const selectWholeDocument = useCallback(() => {
    if (!editor) return false
    // ProseMirror's own selection, not a DOM range: this is an editor, so
    // "select all" has to leave something the next keystroke can replace.
    //
    // Frontmatter is deliberately outside it — it is rendered as a read-only
    // block above the canvas (see this file's doc comment) and is not part of
    // the document the editor owns. Raw mode is where it can be selected.
    editor.chain().focus().selectAll().run()
    return true
  }, [editor])

  useSelectAllScope(richRef, { enabled: mode === 'rich', onSelectAll: selectWholeDocument })

  const findChord = useCommandChordLabel('document.find')

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

  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  // Reuses the same backend conversion the Tools module's "Markdown ->
  // Document" card already ships (POST /api/tools/markdown-export, pandoc +
  // mermaid-cli under the hood) — no new dependency, client or server, for
  // this button. Destination picked before the export request, not after:
  // pandoc's round trip is slow enough to lose the click's transient
  // activation, which would silently degrade showSaveFilePicker to the
  // Downloads folder (see saveFile.ts).
  async function handleExport(format: MarkdownExportFormat) {
    setExportMenuOpen(false)
    const name = exportFilenameBase(path)
    const saveTarget = await pickSaveTarget(`${name}.${format}`)
    if (saveTarget === SAVE_CANCELLED) return
    setExporting(true)
    try {
      const blob = await exportMarkdown(value, format, name)
      await saveTarget.write(blob)
      toast.success(`Exported ${format.toUpperCase()}`)
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Export failed')
    } finally {
      setExporting(false)
    }
  }

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
        {mode === 'rich' ? (
          <>
            <span className="mx-0.5 h-4 w-px bg-notion-divider" />
            <ModeButton
              active={find.open}
              label={findChord ? `Find in document (${findChord})` : 'Find in document'}
              icon={Search}
              onClick={find.open ? find.close : find.openFind}
            />
          </>
        ) : null}
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
        <span className="mx-0.5 h-4 w-px bg-notion-divider" />
        <TabStripPopoverMenu
          trigger={exporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          triggerClassName="flex h-6 w-6 cursor-pointer items-center justify-center rounded-sm text-notion-text-dim transition-colors hover:bg-notion-hover hover:text-notion-text"
          triggerTitle="Export document"
          triggerAriaLabel="Export document"
          align="end"
          open={exportMenuOpen}
          onOpenChange={(open) => !exporting && setExportMenuOpen(open)}
        >
          <button
            type="button"
            onClick={() => handleExport('docx')}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11.5px] text-devdeck-fg-2 hover:bg-devdeck-hover-wash-menu"
          >
            Word (.docx)
          </button>
          <button
            type="button"
            onClick={() => handleExport('pdf')}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[11.5px] text-devdeck-fg-2 hover:bg-devdeck-hover-wash-menu"
          >
            PDF (.pdf)
          </button>
        </TabStripPopoverMenu>
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
        <div ref={richRef} className="relative min-h-0 flex-1">
          {find.open ? <FindBar controller={find} className="absolute right-3 top-3" /> : null}
          {/* `tabIndex` is what makes Cmd+F and Cmd+A work after a click that
              lands in the page margin rather than on text. A plain <div> is
              not focusable, so such a click leaves `document.activeElement` on
              <body>, every keydown targets <body>, and the `contains` scope
              both chords use can never match — which is precisely how "Cmd+A
              selects the whole app instead of the document" happened. -1
              keeps it out of the Tab order; clicking text still focuses the
              contenteditable inside, which is the deeper focus target. */}
          <div ref={scrollRef} tabIndex={-1} className="h-full overflow-auto bg-notion-bg outline-none">
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

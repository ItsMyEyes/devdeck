import { useCallback, useEffect, useRef, useState } from 'react'
import type { editor } from 'monaco-editor/editor'
import { ExternalLink, Eye, PanelRight, Pencil } from 'lucide-react'
import { monaco } from '@/features/editor/monacoSetup'
import { MonacoEditor } from '@/features/editor/MonacoEditor'
import type { LineReveal } from '@/features/editor/reveal'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { MarkdownPreview } from '@/features/issues/MarkdownPreview'
import { SLASH_COMMANDS, TOOLBAR_ACTIONS, type SlashCommand, type ToolbarAction } from '@/features/issues/markdownCommands'

interface SlashMenuState {
  triggerStart: number
  query: string
  top: number
  left: number
  highlighted: number
}

type EditRange = {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
}

/** Applies an edit through monaco's undo-aware `executeEdits`, which keeps the
 *  change on the editor's undo stack — unlike `model.setValue`, which resets
 *  undo history and drops the caret at the start of the document. Callers
 *  place the cursor themselves afterward, since a toolbar wrap and a slash
 *  snippet land the caret in different spots within what was just inserted. */
function applyEdit(instance: editor.IStandaloneCodeEditor, range: EditRange, text: string) {
  instance.executeEdits('devdeck.markdown', [{ range, text, forceMoveMarkers: true }])
}

/**
 * Markdown file editor. Opens read-only, showing just the rendered
 * MarkdownPreview — a top-right Edit button (or double-clicking the preview)
 * switches to edit mode: Monaco on the left, with the same bold/italic/
 * heading toolbar and "/" block-command menu as the Issue description field
 * (markdownCommands.ts's TOOLBAR_ACTIONS/SLASH_COMMANDS are plain
 * string-transform logic, shared as-is), and a live MarkdownPreview on the
 * right — plus a button to pop that live preview out into its own tab
 * (`onOpenPreviewTab`) for callers that have a tab strip to open it into.
 * Unlike the Issue field there's no attachment upload (no issueId to attach
 * to).
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
   *  LineReveal doc comment. Forces edit mode open: a line/column reveal
   *  only means something inside Monaco, never on the rendered preview. */
  reveal?: LineReveal
  /** Edit mode's "open preview in new tab" button — opens `path`'s rendered
   *  preview as its own tab. Omitted by callers with no tab strip to open it
   *  into (the button itself is hidden in that case). */
  onOpenPreviewTab?: (path: string) => void
}) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const previewScrollRef = useRef<HTMLDivElement>(null)
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null)
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  /** Edit mode's live-preview split — hidden lets the editor take the full
   *  width without leaving edit mode (unlike the "Back to preview" button,
   *  which drops the editor entirely). Irrelevant outside edit mode. */
  const [splitVisible, setSplitVisible] = useState(true)

  // A line/column reveal (content search's "open at line") only means
  // something inside Monaco — force edit mode open so it's visible rather
  // than landing silently behind the read-only preview.
  useEffect(() => {
    if (reveal) setMode('edit')
  }, [reveal])

  const filteredCommands = slashMenu
    ? SLASH_COMMANDS.filter((c) => c.label.toLowerCase().includes(slashMenu.query.toLowerCase()))
    : []

  // The keyboard actions registered in handleMount below are set up once (a
  // stable callback identity — Monaco actions are not meant to be
  // re-registered on every render) but still need the *current* slash-menu /
  // filtered-commands state at key-press time, so they read through these
  // refs instead of closing over the state values directly.
  const slashMenuRef = useRef(slashMenu)
  slashMenuRef.current = slashMenu
  const filteredCommandsRef = useRef(filteredCommands)
  filteredCommandsRef.current = filteredCommands

  // Two context keys gate the menu's keyboard actions so they only steal
  // Down/Up/Enter/Tab/Escape from the editor while the menu is actually
  // showing something — otherwise those keys must keep doing what Monaco
  // normally does with them (move the cursor, insert a newline, indent).
  // Escape must still dismiss an empty-match menu, so it depends only on
  // "open"; navigation and selection additionally require a match to act on.
  const menuOpenKeyRef = useRef<editor.IContextKey<boolean> | null>(null)
  const menuHasMatchesKeyRef = useRef<editor.IContextKey<boolean> | null>(null)
  useEffect(() => {
    menuOpenKeyRef.current?.set(slashMenu !== null)
    menuHasMatchesKeyRef.current?.set(slashMenu !== null && filteredCommands.length > 0)
  }, [slashMenu, filteredCommands.length])

  const chooseSlashCommand = useCallback((cmd: SlashCommand) => {
    const instance = editorRef.current
    const model = instance?.getModel()
    const menu = slashMenuRef.current
    const position = instance?.getPosition()
    if (!instance || !model || !menu || !position) return
    const start = model.getPositionAt(menu.triggerStart)
    applyEdit(
      instance,
      {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      },
      cmd.snippet,
    )
    instance.setPosition(model.getPositionAt(menu.triggerStart + cmd.cursorOffset))
    instance.focus()
    setSlashMenu(null)
  }, [])

  const applyToolbarAction = useCallback((apply: ToolbarAction['apply']) => {
    const instance = editorRef.current
    const model = instance?.getModel()
    const selection = instance?.getSelection()
    if (!instance || !model || !selection) return
    const start = model.getOffsetAt({ lineNumber: selection.startLineNumber, column: selection.startColumn })
    const end = model.getOffsetAt({ lineNumber: selection.endLineNumber, column: selection.endColumn })
    const result = apply(model.getValue(), start, end)
    applyEdit(instance, model.getFullModelRange(), result.value)
    const selStart = model.getPositionAt(result.selStart)
    const selEnd = model.getPositionAt(result.selEnd)
    instance.setSelection({
      startLineNumber: selStart.lineNumber,
      startColumn: selStart.column,
      endLineNumber: selEnd.lineNumber,
      endColumn: selEnd.column,
    })
    instance.focus()
  }, [])

  const handleMount = useCallback(
    (instance: editor.IStandaloneCodeEditor) => {
      editorRef.current = instance
      const menuOpenKey = instance.createContextKey<boolean>('devdeckMarkdownSlashOpen', false)
      const menuHasMatchesKey = instance.createContextKey<boolean>('devdeckMarkdownSlashHasMatches', false)
      menuOpenKeyRef.current = menuOpenKey
      menuHasMatchesKeyRef.current = menuHasMatchesKey

      const disposables: Array<{ dispose(): void }> = [
        // Scroll-syncs the live preview to the editor by position fraction
        // (scrollTop / max scroll), not by line — cheap and framework-free,
        // at the cost of drifting on documents where the editor and the
        // rendered preview don't grow at the same rate (e.g. a huge mermaid
        // diagram). One-directional: scrolling the preview itself doesn't
        // move the editor back.
        instance.onDidScrollChange((event) => {
          const preview = previewScrollRef.current
          if (!preview) return
          const maxEditorScroll = event.scrollHeight - instance.getLayoutInfo().height
          const maxPreviewScroll = preview.scrollHeight - preview.clientHeight
          if (maxEditorScroll <= 0 || maxPreviewScroll <= 0) return
          const fraction = Math.min(1, Math.max(0, event.scrollTop / maxEditorScroll))
          preview.scrollTop = fraction * maxPreviewScroll
        }),
        // Drives the slash-menu state machine off monaco's own content-change
        // event rather than a derived `onChange(value)` string: the event
        // carries the exact edit (`rangeOffset` + inserted `text`), so the
        // caret used below is never subject to a race with monaco's cursor
        // controller the way re-querying `instance.getPosition()` here would
        // be.
        instance.onDidChangeModelContent((event) => {
          if (event.changes.length !== 1) return
          const model = instance.getModel()
          if (!model) return
          const change = event.changes[0]
          const caret = change.rangeOffset + change.text.length
          const nextValue = model.getValue()

          const menu = slashMenuRef.current
          if (menu) {
            if (caret <= menu.triggerStart || nextValue[menu.triggerStart] !== '/') {
              setSlashMenu(null)
              return
            }
            const query = nextValue.slice(menu.triggerStart + 1, caret)
            setSlashMenu(/\s/.test(query) ? null : { ...menu, query, highlighted: 0 })
            return
          }

          // Only trigger at the start of a line, like the Issue description editor.
          if (nextValue[caret - 1] === '/' && (caret < 2 || nextValue[caret - 2] === '\n')) {
            const position = model.getPositionAt(caret)
            const coords = instance.getScrolledVisiblePosition(position)
            const containerRect = containerRef.current?.getBoundingClientRect()
            const editorRect = instance.getDomNode()?.getBoundingClientRect()
            if (!coords || !containerRect || !editorRect) return
            setSlashMenu({
              triggerStart: caret - 1,
              query: '',
              top: coords.top + coords.height + (editorRect.top - containerRect.top) + 4,
              left: coords.left + (editorRect.left - containerRect.left),
              highlighted: 0,
            })
          }
        }),
        instance.addAction({
          id: 'devdeck.markdown.slashNext',
          label: 'Next slash command',
          precondition: 'devdeckMarkdownSlashHasMatches',
          keybindings: [monaco.KeyCode.DownArrow],
          run: () => {
            const commands = filteredCommandsRef.current
            setSlashMenu((prev) =>
              prev && commands.length > 0 ? { ...prev, highlighted: (prev.highlighted + 1) % commands.length } : prev,
            )
          },
        }),
        instance.addAction({
          id: 'devdeck.markdown.slashPrev',
          label: 'Previous slash command',
          precondition: 'devdeckMarkdownSlashHasMatches',
          keybindings: [monaco.KeyCode.UpArrow],
          run: () => {
            const commands = filteredCommandsRef.current
            setSlashMenu((prev) =>
              prev && commands.length > 0
                ? { ...prev, highlighted: (prev.highlighted - 1 + commands.length) % commands.length }
                : prev,
            )
          },
        }),
        instance.addAction({
          id: 'devdeck.markdown.slashChoose',
          label: 'Choose slash command',
          precondition: 'devdeckMarkdownSlashHasMatches',
          keybindings: [monaco.KeyCode.Enter, monaco.KeyCode.Tab],
          run: () => {
            const menu = slashMenuRef.current
            const commands = filteredCommandsRef.current
            if (menu && commands.length > 0) chooseSlashCommand(commands[menu.highlighted])
          },
        }),
        instance.addAction({
          id: 'devdeck.markdown.slashDismiss',
          label: 'Dismiss slash menu',
          precondition: 'devdeckMarkdownSlashOpen',
          keybindings: [monaco.KeyCode.Escape],
          run: () => setSlashMenu(null),
        }),
      ]

      return () => {
        for (const disposable of disposables) disposable.dispose()
        editorRef.current = null
        menuOpenKeyRef.current = null
        menuHasMatchesKeyRef.current = null
      }
    },
    [chooseSlashCommand],
  )

  if (mode === 'preview') {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-auto bg-devdeck-pane">
        <Tooltip label="Edit (or double-click)">
          <button
            type="button"
            onClick={() => setMode('edit')}
            aria-label="Edit"
            className="absolute right-4 top-4 z-10 flex h-7 items-center gap-1.5 rounded border border-devdeck-border-strong bg-devdeck-glass-solid px-2.5 text-[11px] text-devdeck-fg-2 hover:border-devdeck-border-accent hover:text-devdeck-accent"
          >
            <Pencil size={12} />
            Edit
          </button>
        </Tooltip>
        <div onDoubleClick={() => setMode('edit')} className="min-h-full flex-1 cursor-text px-6 py-6">
          <MarkdownPreview source={value} />
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', splitVisible && 'border-r border-devdeck-border')}>
        <div className="flex flex-none flex-wrap items-center gap-0.5 border-b border-devdeck-border bg-devdeck-pane px-2 py-1.5">
          {TOOLBAR_ACTIONS.map((action) => (
            <Tooltip key={action.id} label={action.label}>
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyToolbarAction(action.apply)}
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg-2"
              >
                <action.icon size={13} />
              </button>
            </Tooltip>
          ))}
          <span className="mx-0.5 h-4 w-px bg-devdeck-border-strong" />
          <Tooltip label={splitVisible ? 'Hide preview' : 'Show preview'}>
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setSplitVisible((visible) => !visible)}
              aria-label={splitVisible ? 'Hide preview' : 'Show preview'}
              aria-pressed={splitVisible}
              className={cn(
                'flex h-6 w-6 cursor-pointer items-center justify-center rounded transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg-2',
                splitVisible ? 'text-devdeck-accent' : 'text-devdeck-fg-2',
              )}
            >
              <PanelRight size={13} />
            </button>
          </Tooltip>
          <Tooltip label="Back to preview">
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setMode('preview')}
              aria-label="Preview"
              className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg-2"
            >
              <Eye size={13} />
            </button>
          </Tooltip>
          {onOpenPreviewTab ? (
            <Tooltip label="Open preview in new tab">
              <button
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onOpenPreviewTab(path)}
                aria-label="Open preview in new tab"
                className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg-2"
              >
                <ExternalLink size={13} />
              </button>
            </Tooltip>
          ) : null}
        </div>

        <div ref={containerRef} className="relative min-h-0 flex-1">
          <MonacoEditor
            path={path}
            value={value}
            ready={ready}
            reveal={reveal}
            onChange={onChange}
            onMount={handleMount}
            language="markdown"
            ariaLabel={`Edit ${path}`}
            options={{ wordWrap: 'on', lineNumbers: 'off', quickSuggestions: false }}
            className="h-full min-h-0 flex-1"
          />

          {slashMenu && filteredCommands.length > 0 ? (
            <div
              className="absolute z-[70] flex w-56 flex-col gap-0.5 rounded-control border border-devdeck-border-menu bg-devdeck-glass-solid p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.55)]"
              style={{ top: slashMenu.top, left: slashMenu.left }}
            >
              {filteredCommands.map((cmd, i) => (
                <button
                  key={cmd.id}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseSlashCommand(cmd)}
                  className={cn(
                    'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
                    i === slashMenu.highlighted ? 'bg-white/[0.05] text-devdeck-fg' : 'text-devdeck-fg-2 hover:bg-white/[0.05]',
                  )}
                >
                  <cmd.icon size={14} className="flex-none text-devdeck-fg-2" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[12.5px]">{cmd.label}</span>
                    <span className="truncate text-[10.5px] text-devdeck-fg-2">{cmd.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {splitVisible ? (
        <div ref={previewScrollRef} className="min-h-0 min-w-0 flex-1 overflow-auto bg-devdeck-pane px-6 py-6">
          <MarkdownPreview source={value} />
        </div>
      ) : null}
    </div>
  )
}

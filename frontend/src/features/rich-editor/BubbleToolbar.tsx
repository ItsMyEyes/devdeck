import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import { BubbleMenu } from '@tiptap/react/menus'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { BLOCK_COMMANDS, LINK_ACTION, MARK_ACTIONS, TOOLBAR_BLOCK_IDS } from './blocks'

const TOOLBAR_BLOCKS = TOOLBAR_BLOCK_IDS.map(
  (id) => BLOCK_COMMANDS.find((command) => command.id === id)!,
)

function ToolbarButton({
  label,
  icon: Icon,
  active,
  onClick,
}: {
  label: string
  icon: typeof LINK_ACTION.icon
  active?: boolean
  onClick: () => void
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        // Keeps the editor selection alive: without this the mousedown blurs
        // ProseMirror first and the command runs against a collapsed cursor.
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'flex h-7 w-7 cursor-pointer items-center justify-center rounded-sm transition-colors hover:bg-notion-hover',
          active ? 'text-notion-blue' : 'text-notion-text hover:text-notion-text-strong',
        )}
      >
        <Icon size={13} />
      </button>
    </Tooltip>
  )
}

/**
 * Selection toolbar: inline marks, a link prompt, and the handful of "turn
 * into" blocks worth one click. Everything else lives in the "/" menu.
 *
 * Replaces the always-visible toolbar strip the markdown editors used to
 * carry — with a WYSIWYG canvas there's nothing to format until something is
 * selected, so the controls follow the selection instead of taking up a row.
 */
export function BubbleToolbar({ editor }: { editor: Editor }) {
  // `isActive` reads the current selection, so it has to be re-read on every
  // transaction — plain render-time calls would freeze on whatever the state
  // was when the toolbar first mounted and no button would ever light up.
  // No `equalityFn`: the default deep-equals this flag bag, so the toolbar
  // re-renders on a selection that changes what's active and not on one that
  // merely moves the caret.
  const active = useEditorState({
    editor,
    selector: ({ editor: instance }) => ({
      link: instance.isActive('link'),
      marks: MARK_ACTIONS.map((action) => action.isActive(instance)),
      blocks: TOOLBAR_BLOCKS.map((block) => block.isActive?.(instance) ?? false),
    }),
  })

  function editLink() {
    const current = editor.getAttributes('link').href as string | undefined
    const href = window.prompt('Link URL', current ?? 'https://')
    if (href === null) return
    const chain = editor.chain().focus().extendMarkRange('link')
    if (href.trim()) chain.setLink({ href: href.trim() }).run()
    else chain.unsetLink().run()
  }

  return (
    <BubbleMenu
      editor={editor}
      shouldShow={({ editor: instance, state, from, to }) => {
        if (from === to) return false
        // Marks mean nothing inside a fence, and a node selection (image,
        // divider) has no text to wrap.
        if (instance.isActive('codeBlock')) return false
        return state.doc.textBetween(from, to, ' ').trim().length > 0
      }}
      // One row, like Notion's: wrapping a 12-button strip onto a second line
      // puts half the controls where the selection isn't.
      className="flex items-center gap-0.5 rounded-sm bg-notion-surface p-1 font-[family-name:var(--nt-font)] shadow-[var(--nt-shadow)]"
    >
      {MARK_ACTIONS.map((action, index) => (
        <ToolbarButton
          key={action.id}
          label={action.label}
          icon={action.icon}
          active={active.marks[index]}
          onClick={() => action.apply(editor.chain().focus()).run()}
        />
      ))}
      <ToolbarButton
        label={LINK_ACTION.label}
        icon={LINK_ACTION.icon}
        active={active.link}
        onClick={editLink}
      />
      <span className="mx-1 h-5 w-px bg-notion-divider" />
      {TOOLBAR_BLOCKS.map((block, index) => (
        <ToolbarButton
          key={block.id}
          label={block.label}
          icon={block.icon}
          active={active.blocks[index]}
          onClick={() => block.apply(editor.chain().focus()).run()}
        />
      ))}
    </BubbleMenu>
  )
}

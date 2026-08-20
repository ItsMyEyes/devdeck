import type { ChainedCommands, Editor } from '@tiptap/core'
import type { LucideIcon } from 'lucide-react'
import {
  Bold,
  Code,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Pilcrow,
  Quote,
  Strikethrough,
  Table,
  Workflow,
} from 'lucide-react'

/**
 * The block and mark vocabulary of the WYSIWYG editor, shared by the "/" menu
 * and the selection toolbar so the two can never drift apart.
 *
 * The markdown editors these replaced drove formatting with string transforms
 * over the raw text ("wrap the selection in `**`"). Here the unit is a Tiptap
 * command: the editor owns the document, and markdown is only ever produced at
 * serialize time.
 */

export interface BlockCommand {
  id: string
  label: string
  hint: string
  icon: LucideIcon
  /** Extra words the "/" menu matches on beyond `label` — so "todo" finds the
   *  task list and "hr" finds the divider. */
  keywords?: string[]
  /** Applies the block to a chain the caller has already focused — and, for
   *  the "/" menu, already pointed at the range the "/query" text occupied.
   *  Set-rather-than-toggle semantics: picking "Heading 1" while already in an
   *  h1 should leave an h1, not silently undo it. */
  apply: (chain: ChainedCommands) => ChainedCommands
  isActive?: (editor: Editor) => boolean
}

const MERMAID_TEMPLATE = 'graph TD\n  A[Start] --> B[Done]'

/** Ordered as the "/" menu shows them: the blocks people reach for most first. */
export const BLOCK_COMMANDS: BlockCommand[] = [
  {
    id: 'paragraph',
    label: 'Text',
    hint: 'Plain paragraph',
    icon: Pilcrow,
    keywords: ['plain', 'body'],
    apply: (chain) => chain.setParagraph(),
    isActive: (editor) => editor.isActive('paragraph'),
  },
  {
    id: 'h1',
    label: 'Heading 1',
    hint: 'Big section heading',
    icon: Heading1,
    keywords: ['title'],
    apply: (chain) => chain.setHeading({ level: 1 }),
    isActive: (editor) => editor.isActive('heading', { level: 1 }),
  },
  {
    id: 'h2',
    label: 'Heading 2',
    hint: 'Medium section heading',
    icon: Heading2,
    apply: (chain) => chain.setHeading({ level: 2 }),
    isActive: (editor) => editor.isActive('heading', { level: 2 }),
  },
  {
    id: 'h3',
    label: 'Heading 3',
    hint: 'Small section heading',
    icon: Heading3,
    apply: (chain) => chain.setHeading({ level: 3 }),
    isActive: (editor) => editor.isActive('heading', { level: 3 }),
  },
  {
    id: 'bulletList',
    label: 'Bullet list',
    hint: 'Simple bullet list',
    icon: List,
    keywords: ['unordered', 'ul'],
    apply: (chain) => chain.toggleBulletList(),
    isActive: (editor) => editor.isActive('bulletList'),
  },
  {
    id: 'orderedList',
    label: 'Numbered list',
    hint: 'List with numbering',
    icon: ListOrdered,
    keywords: ['ordered', 'ol'],
    apply: (chain) => chain.toggleOrderedList(),
    isActive: (editor) => editor.isActive('orderedList'),
  },
  {
    id: 'taskList',
    label: 'Task list',
    hint: 'Track tasks with checkboxes',
    icon: ListTodo,
    keywords: ['todo', 'checkbox', 'checklist'],
    apply: (chain) => chain.toggleTaskList(),
    isActive: (editor) => editor.isActive('taskList'),
  },
  {
    id: 'blockquote',
    label: 'Quote',
    hint: 'Capture a quote',
    icon: Quote,
    keywords: ['blockquote'],
    apply: (chain) => chain.toggleBlockquote(),
    isActive: (editor) => editor.isActive('blockquote'),
  },
  {
    id: 'codeBlock',
    label: 'Code block',
    hint: 'Fenced code block',
    icon: Code2,
    keywords: ['fence', 'snippet'],
    apply: (chain) => chain.setCodeBlock(),
    isActive: (editor) => editor.isActive('codeBlock'),
  },
  {
    id: 'table',
    label: 'Table',
    hint: '2 columns with a header row',
    icon: Table,
    keywords: ['grid'],
    apply: (chain) => chain.insertTable({ rows: 3, cols: 2, withHeaderRow: true }),
    isActive: (editor) => editor.isActive('table'),
  },
  {
    id: 'mermaid',
    label: 'Mermaid diagram',
    hint: 'Renders as you type',
    icon: Workflow,
    keywords: ['diagram', 'graph', 'flowchart'],
    // A ```mermaid fence is just a code block with a language, so it survives
    // the markdown round-trip like any other. The starter content saves the
    // user from staring at an empty fence wondering about the syntax.
    // No `isActive`: like the divider below, this one *inserts* a node rather
    // than transforming the current block, and the caret ends up after it —
    // there is no state to report.
    apply: (chain) =>
      chain.insertContent({
        type: 'codeBlock',
        attrs: { language: 'mermaid' },
        content: [{ type: 'text', text: MERMAID_TEMPLATE }],
      }),
  },
  {
    id: 'horizontalRule',
    label: 'Divider',
    hint: 'Horizontal rule',
    icon: Minus,
    keywords: ['hr', 'separator', 'line'],
    apply: (chain) => chain.setHorizontalRule(),
  },
]

/** Case-insensitive match over label and keywords, preserving menu order. */
export function matchBlockCommands(query: string): BlockCommand[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return BLOCK_COMMANDS
  return BLOCK_COMMANDS.filter(
    (command) =>
      command.label.toLowerCase().includes(needle) ||
      command.keywords?.some((keyword) => keyword.includes(needle)),
  )
}

export interface MarkAction {
  id: string
  label: string
  icon: LucideIcon
  apply: (chain: ChainedCommands) => ChainedCommands
  isActive: (editor: Editor) => boolean
}

/** Inline formatting, shown in the selection toolbar. `link` is deliberately
 *  absent — it needs a URL prompt, so the toolbar handles it separately. */
export const MARK_ACTIONS: MarkAction[] = [
  {
    id: 'bold',
    label: 'Bold',
    icon: Bold,
    apply: (chain) => chain.toggleBold(),
    isActive: (editor) => editor.isActive('bold'),
  },
  {
    id: 'italic',
    label: 'Italic',
    icon: Italic,
    apply: (chain) => chain.toggleItalic(),
    isActive: (editor) => editor.isActive('italic'),
  },
  {
    id: 'strike',
    label: 'Strikethrough',
    icon: Strikethrough,
    apply: (chain) => chain.toggleStrike(),
    isActive: (editor) => editor.isActive('strike'),
  },
  {
    id: 'code',
    label: 'Inline code',
    icon: Code,
    apply: (chain) => chain.toggleCode(),
    isActive: (editor) => editor.isActive('code'),
  },
]

export const LINK_ACTION = { id: 'link', label: 'Link', icon: Link2 } as const

/** The blocks offered as a "turn into" row in the selection toolbar — the
 *  handful worth one click, not the whole "/" menu. */
export const TOOLBAR_BLOCK_IDS = ['h1', 'h2', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock']

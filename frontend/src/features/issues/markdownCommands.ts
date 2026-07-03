import type { LucideIcon } from 'lucide-react'
import {
  Bold,
  Code,
  Code2,
  Heading1,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Quote,
  Strikethrough,
  Table,
} from 'lucide-react'

export interface EditResult {
  value: string
  selStart: number
  selEnd: number
}

/** Wraps the selection in `before`/`after`; falls back to `placeholder` text
 *  (selected, so typing overwrites it) when nothing is selected. */
function wrapSelection(
  value: string,
  start: number,
  end: number,
  before: string,
  after: string,
  placeholder: string,
): EditResult {
  const selected = value.slice(start, end) || placeholder
  const next = value.slice(0, start) + before + selected + after + value.slice(end)
  const selStart = start + before.length
  return { value: next, selStart, selEnd: selStart + selected.length }
}

/** Prefixes every line touched by the selection (expanding to full lines first). */
function prefixLines(value: string, start: number, end: number, prefix: string | ((line: number) => string)): EditResult {
  const lineStart = value.lastIndexOf('\n', start - 1) + 1
  let lineEnd = value.indexOf('\n', end)
  if (lineEnd === -1) lineEnd = value.length
  const lines = value.slice(lineStart, lineEnd).split('\n')
  const next = lines.map((line, i) => (typeof prefix === 'function' ? prefix(i) : prefix) + line).join('\n')
  return {
    value: value.slice(0, lineStart) + next + value.slice(lineEnd),
    selStart: lineStart,
    selEnd: lineStart + next.length,
  }
}

export interface ToolbarAction {
  id: string
  label: string
  icon: LucideIcon
  apply: (value: string, start: number, end: number) => EditResult
}

/** Formatting toolbar shown above the description textarea while editing. */
export const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { id: 'bold', label: 'Bold', icon: Bold, apply: (v, s, e) => wrapSelection(v, s, e, '**', '**', 'bold text') },
  { id: 'italic', label: 'Italic', icon: Italic, apply: (v, s, e) => wrapSelection(v, s, e, '*', '*', 'italic text') },
  {
    id: 'strike',
    label: 'Strikethrough',
    icon: Strikethrough,
    apply: (v, s, e) => wrapSelection(v, s, e, '~~', '~~', 'strikethrough'),
  },
  { id: 'code', label: 'Inline code', icon: Code, apply: (v, s, e) => wrapSelection(v, s, e, '`', '`', 'code') },
  { id: 'heading', label: 'Heading', icon: Heading2, apply: (v, s, e) => prefixLines(v, s, e, '## ') },
  { id: 'quote', label: 'Quote', icon: Quote, apply: (v, s, e) => prefixLines(v, s, e, '> ') },
  { id: 'bulleted', label: 'Bullet list', icon: List, apply: (v, s, e) => prefixLines(v, s, e, '- ') },
  {
    id: 'numbered',
    label: 'Numbered list',
    icon: ListOrdered,
    apply: (v, s, e) => prefixLines(v, s, e, (i) => `${i + 1}. `),
  },
  { id: 'task', label: 'Task list', icon: ListTodo, apply: (v, s, e) => prefixLines(v, s, e, '- [ ] ') },
  {
    id: 'codeblock',
    label: 'Code block',
    icon: Code2,
    apply: (v, s, e) => wrapSelection(v, s, e, '```\n', '\n```', 'code'),
  },
  { id: 'link', label: 'Link', icon: Link2, apply: (v, s, e) => wrapSelection(v, s, e, '[', '](url)', 'link text') },
]

export interface SlashCommand {
  id: string
  label: string
  hint: string
  icon: LucideIcon
  /** Inserted in place of the "/query" trigger text. */
  snippet: string
  /** Caret offset (from the start of `snippet`) to land on after insertion. */
  cursorOffset: number
}

/** Block commands shown by the "/" popup, triggered at the start of a line. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { id: 'h1', label: 'Heading 1', hint: 'Big section heading', icon: Heading1, snippet: '# ', cursorOffset: 2 },
  { id: 'h2', label: 'Heading 2', hint: 'Medium section heading', icon: Heading2, snippet: '## ', cursorOffset: 3 },
  { id: 'bulleted', label: 'Bullet list', hint: 'Simple bullet list', icon: List, snippet: '- ', cursorOffset: 2 },
  {
    id: 'numbered',
    label: 'Numbered list',
    hint: 'List with numbering',
    icon: ListOrdered,
    snippet: '1. ',
    cursorOffset: 3,
  },
  {
    id: 'task',
    label: 'Task list',
    hint: 'Track tasks with checkboxes',
    icon: ListTodo,
    snippet: '- [ ] ',
    cursorOffset: 6,
  },
  { id: 'quote', label: 'Quote', hint: 'Capture a quote', icon: Quote, snippet: '> ', cursorOffset: 2 },
  {
    id: 'code',
    label: 'Code block',
    hint: 'Fenced code block',
    icon: Code2,
    snippet: '```\n\n```',
    cursorOffset: 4,
  },
  {
    id: 'table',
    label: 'Table',
    hint: '2x2 table',
    icon: Table,
    snippet: '| Col 1 | Col 2 |\n| --- | --- |\n|  |  |\n',
    cursorOffset: 2,
  },
  { id: 'divider', label: 'Divider', hint: 'Horizontal rule', icon: Minus, snippet: '---\n', cursorOffset: 4 },
]

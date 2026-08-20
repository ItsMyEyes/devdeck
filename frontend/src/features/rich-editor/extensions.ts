import type { Extensions } from '@tiptap/core'
import { Placeholder } from '@tiptap/extensions'
import { Image } from '@tiptap/extension-image'
import { TaskItem } from '@tiptap/extension-list/task-item'
import { TaskList } from '@tiptap/extension-list/task-list'
import { TableKit } from '@tiptap/extension-table/kit'
import { Markdown } from '@tiptap/markdown'
import { StarterKit } from '@tiptap/starter-kit'
import { MermaidCodeBlock } from './mermaidCodeBlock'
import { SlashCommand } from './slashCommand'

/** Shown on the empty node the caret is sitting in, the way Notion does it —
 *  the affordance that tells a first-time user the "/" menu exists at all. */
const CARET_PLACEHOLDER = "Type '/' for commands…"

export interface EditorExtensionOptions {
  /** Read through a getter rather than captured, so a caller can change the
   *  empty-document placeholder without tearing the editor down and losing
   *  its content and undo history. */
  placeholder?: () => string | undefined
}

/**
 * The extension set behind every DevDeck WYSIWYG surface.
 *
 * Deliberately Tiptap's DEFAULT configuration. StarterKit v3 already brings the
 * CommonMark core plus Link, TrailingNode and the list keymap; added on top are
 * only the GitHub-flavored pieces markdown files actually use (tables, task
 * lists), images for issue attachments, and the `@tiptap/markdown` extension
 * that makes `editor.getMarkdown()` and `setContent(md, { contentType:
 * 'markdown' })` the editor's whole I/O surface — no HTML ever crosses the
 * boundary. Everything visual is CSS (`.notion-doc` in globals.css), not
 * extension options.
 *
 * The `configure` calls below are the only settings whose default is wrong for
 * a markdown editor; every other option, including Link's `rel` and `target`,
 * Image's `inline`/`allowBase64`, marked's `gfm`/`breaks` and Placeholder's
 * `includeChildren`, is already the default we want.
 *
 * The one node with behaviour of its own is the code block, swapped for
 * `MermaidCodeBlock` so a ```mermaid fence renders as a diagram. It is
 * StarterKit's own CodeBlock with a node view added, so no other fence
 * notices.
 */
export function createEditorExtensions(options: EditorExtensionOptions = {}): Extensions {
  return [
    StarterKit.configure({
      // Default is `openOnClick: true`. Links are content here, not
      // navigation: clicking one must place the caret rather than throw the
      // user out of a document with unsaved edits. The toolbar follows it.
      link: { openOnClick: false },
      // Turned off so MermaidCodeBlock below can take the `codeBlock` node
      // name. It *is* StarterKit's CodeBlock, extended — same node, same
      // options, same markdown; it only adds the diagram node view.
      codeBlock: false,
    }),
    MermaidCodeBlock,
    TaskList,
    // Default is `nested: false`, which would flatten the sub-items of any
    // indented checklist in a file the editor opens.
    TaskItem.configure({ nested: true }),
    // Default is `resizable: false`; column widths are a Notion table's whole
    // point, and the widths survive as plain markdown pipes either way.
    TableKit.configure({ table: { resizable: true } }),
    Image,
    Placeholder.configure({
      placeholder: ({ pos }) => (pos === 0 ? (options.placeholder?.() ?? CARET_PLACEHOLDER) : CARET_PLACEHOLDER),
    }),
    // Defaults to marked's own options: `gfm: true`, `breaks: false` — a single
    // newline stays a soft wrap, which is what a markdown file means by it.
    // Hard breaks still round-trip through HardBreak's backslash line ending.
    Markdown,
    SlashCommand,
  ]
}

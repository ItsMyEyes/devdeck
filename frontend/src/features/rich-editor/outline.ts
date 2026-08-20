import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export interface OutlineHeading {
  /** Document position of the heading node. Doubles as the React key and as
   *  the handle for reaching its DOM (`view.nodeDOM(pos)`) to scroll to it. */
  pos: number
  level: number
  /** Empty for a heading the user has started but not written yet — the rail
   *  still draws its dash, so the document's shape stays honest. */
  text: string
}

/**
 * The document's headings, in document order — the model behind the outline
 * rail on the right edge of a page.
 *
 * Kept out of the component so it can be tested against a real document
 * without a DOM, and so the rail re-reads it from one place on every update.
 */
export function collectHeadings(doc: ProseMirrorNode): OutlineHeading[] {
  const headings: OutlineHeading[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return true
    headings.push({ pos, level: Number(node.attrs.level) || 1, text: node.textContent.trim() })
    // A heading's children are inline text; nothing below it is a heading.
    return false
  })
  return headings
}

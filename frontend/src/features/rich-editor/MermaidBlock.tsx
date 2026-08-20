import type { NodeViewProps } from '@tiptap/react'
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react'
import { MermaidDiagram } from './MermaidDiagram'

/**
 * The node view a ```mermaid fence gets on the WYSIWYG canvas: the fence stays
 * an ordinary editable code block, and the diagram it describes renders
 * underneath it, live, as it is typed.
 *
 * Source *and* diagram rather than one or the other. Swapping the source out
 * for the diagram when the caret leaves the block is the more Notion-like
 * behaviour, but it means the editable content is `display: none` at the
 * moment ProseMirror has to place a selection inside it — which it cannot do.
 * Keeping both on screen costs some height and has no such failure mode. A
 * reader never pays that cost: the source is hidden on a non-editable canvas
 * (globals.css), so a rendered document shows the diagram alone.
 *
 * The node is still a plain `codeBlock` with `language: 'mermaid'` — nothing
 * here touches the document model, so the markdown round-trip is untouched.
 */
export function MermaidBlock({ node }: NodeViewProps) {
  return (
    <NodeViewWrapper className="notion-mermaid">
      {/* `as="pre"` + the extension's `contentDOMElementTag: 'code'` reproduce
          the `pre > code` shape a code block renders as by default, so the
          fence keeps the theme's code styling with no extra rules. */}
      {/* The explicit type argument is required: `as` is typed `NoInfer<T>`,
          so the tag never widens from its `'div'` default on its own. */}
      <NodeViewContent<'pre'> as="pre" className="notion-mermaid__source" />
      {/* contentEditable=false: the diagram is rendered output, not content —
          without it ProseMirror would let the caret into the SVG. */}
      <div className="notion-mermaid__diagram" contentEditable={false}>
        <MermaidDiagram chart={node.textContent} />
      </div>
    </NodeViewWrapper>
  )
}

import { CodeBlock } from '@tiptap/extension-code-block'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { MermaidBlock } from './MermaidBlock'

/** The language a fence has to declare to be rendered as a diagram. */
export const MERMAID_LANGUAGE = 'mermaid'

/**
 * StarterKit's CodeBlock, with one addition: a fence whose language is
 * `mermaid` renders its diagram inline (see `MermaidBlock`).
 *
 * Every *other* code block deliberately gets no node view. ProseMirror falls
 * back to an extension's normal `renderHTML` whenever a node view constructor
 * returns nothing, so returning `undefined` here leaves a ```ts fence rendering
 * through exactly the same path it did before this extension existed — no
 * React, no wrapper elements, no chance of regressing the common case for the
 * sake of the rare one.
 */
export const MermaidCodeBlock = CodeBlock.extend({
  addNodeView() {
    // Built once, outside the per-node callback: ReactNodeViewRenderer returns
    // the renderer, and building one per node would rebuild it on every
    // keystroke that re-creates the view.
    const renderDiagram = ReactNodeViewRenderer(MermaidBlock, {
      // Makes the editable content element a `<code>`, so that with
      // MermaidBlock's `NodeViewContent as="pre"` the fence keeps the
      // `pre > code` shape the theme styles.
      contentDOMElementTag: 'code',
    })
    return (props) =>
      props.node.attrs.language === MERMAID_LANGUAGE
        ? renderDiagram(props)
        : // Not a diagram — hand ProseMirror nothing and let CodeBlock's own
          // renderHTML draw it. The cast is only needed because Tiptap types
          // the renderer as always producing a NodeView.
          (undefined as never)
  },
})

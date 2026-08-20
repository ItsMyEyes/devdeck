/**
 * Plan T3 — the three composer chip node types the prompt editor's document
 * can hold: `composerFileChip` (the only one this plan's `@` trigger ever
 * inserts), `composerSkillChip` and `composerTerminalContextChip` (defined
 * now, wired up by later specs — see the design spec's §5 "Dormant
 * triggers"). All three are inline ProseMirror atoms — no cursor can land
 * inside one, and they behave as a single character for cursor movement and
 * deletion.
 *
 * One node view serves all three, T2's `ComposerChip` (`ComposerChip.tsx`),
 * mounted through `ReactNodeViewRenderer`. The remove control stays inside
 * `ComposerChip`'s own DOM — see that file's header for why nothing here
 * portals it out (`posAtCoords` can only resolve back into a document
 * position through a node view's own DOM).
 *
 * `composerChipNodeToChip` is the bridge back to T1's pure serialization
 * (`composerSerialize.ts`): it turns a node's `{ type, attrs }` JSON — what
 * both `node.toJSON()` and `editor.getJSON()` produce — into the
 * `ComposerChipNode` shape `serializeComposerDoc` consumes. T5's editor calls
 * it once per chip node when it turns the live document into the string
 * `onChange`/`onSend` see.
 */
import { createElement } from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'

import { ComposerChip } from '@/features/agent-chat/ComposerChip'
import type { ComposerChipKind as ComposerChipViewKind } from '@/features/agent-chat/ComposerChip'
import type { ComposerChipKind, ComposerChipNode } from '@/features/agent-chat/composerSerialize'

/** Node-type name each T1 chip kind is registered under. */
const NODE_NAME_BY_CHIP_KIND: Record<ComposerChipKind, string> = {
  file: 'composerFileChip',
  skill: 'composerSkillChip',
  terminalContext: 'composerTerminalContextChip',
}

/** Inverse of the above — a node's `type` name back to T1's chip kind. */
const CHIP_KIND_BY_NODE_NAME: Record<string, ComposerChipKind> = {
  composerFileChip: 'file',
  composerSkillChip: 'skill',
  composerTerminalContextChip: 'terminalContext',
}

/** T2's `ComposerChip` uses its own (kebab-case) kind vocabulary, distinct
 *  from T1's — see `ComposerChip.tsx`'s `ComposerChipKind`. This is the node
 *  view's lookup, never T1's serialization. */
const VIEW_KIND_BY_NODE_NAME: Record<string, ComposerChipViewKind> = {
  composerFileChip: 'file',
  composerSkillChip: 'skill',
  composerTerminalContextChip: 'terminal-context',
}

/** The node-type name a chip kind is inserted as — the lookup a caller (T4's
 *  `@` trigger, T5's editor) needs to insert e.g. a file chip. */
export function composerChipNodeName(kind: ComposerChipKind): string {
  return NODE_NAME_BY_CHIP_KIND[kind]
}

interface ChipNodeJSON {
  type: string
  attrs?: {
    value?: unknown
    label?: unknown
  }
}

/** A chip node's `{ type, attrs }` JSON → T1's `ComposerChipNode`. Throws for
 *  any node type that is not one of the three chip nodes — callers only ever
 *  reach this for a node they already know is a chip. */
export function composerChipNodeToChip(node: ChipNodeJSON): ComposerChipNode {
  const kind = CHIP_KIND_BY_NODE_NAME[node.type]
  if (!kind) throw new Error(`composerChipNodeToChip: "${node.type}" is not a composer chip node`)

  const value = typeof node.attrs?.value === 'string' ? node.attrs.value : ''
  const label = typeof node.attrs?.label === 'string' ? node.attrs.label : undefined

  return label === undefined ? { type: 'chip', kind, value } : { type: 'chip', kind, value, label }
}

/** The node view shared by all three chip node types — presentational work
 *  lives entirely in T2's `ComposerChip`; this only adapts ProseMirror's
 *  `NodeViewProps` to its props. `deleteNode` (from `NodeViewProps`) removes
 *  exactly this node from the document, wherever it currently sits.
 *
 *  `NodeViewWrapper` is required, not decorative: `ReactNodeViewRenderer`
 *  throws ("Please use the NodeViewWrapper component for your node view.")
 *  unless the node view's rendered root carries its `data-node-view-wrapper`
 *  marker — `as="span"` keeps it inline, matching the atom it wraps. */
function ChipNodeView({ node, deleteNode }: NodeViewProps) {
  const kind = VIEW_KIND_BY_NODE_NAME[node.type.name]
  const label =
    typeof node.attrs.label === 'string' && node.attrs.label.length > 0
      ? node.attrs.label
      : String(node.attrs.value ?? '')

  return createElement(
    NodeViewWrapper,
    { as: 'span' },
    createElement(ComposerChip, { kind, label, onRemove: deleteNode }),
  )
}
ChipNodeView.displayName = 'ComposerChipNodeView'

/** One inline atom node definition, parameterized only by its registered
 *  name — kind-specific behavior (icon, label fallback) lives entirely in
 *  `ChipNodeView` / `ComposerChip`, keyed off that same name. */
function createComposerChipNode(name: string) {
  return Node.create({
    name,
    group: 'inline',
    inline: true,
    atom: true,

    addAttributes() {
      return {
        value: {
          default: '',
          parseHTML: (element: HTMLElement) => element.getAttribute('data-value') ?? '',
          renderHTML: (attributes: { value: string }) => ({ 'data-value': attributes.value }),
        },
        label: {
          default: null,
          parseHTML: (element: HTMLElement) => element.getAttribute('data-label'),
          renderHTML: (attributes: { label: string | null }) =>
            attributes.label ? { 'data-label': attributes.label } : {},
        },
      }
    },

    parseHTML() {
      return [{ tag: `span[data-composer-chip="${name}"]` }]
    },

    renderHTML({ HTMLAttributes, node }) {
      const label = typeof node.attrs.label === 'string' ? node.attrs.label : String(node.attrs.value ?? '')
      return ['span', mergeAttributes(HTMLAttributes, { 'data-composer-chip': name }), label]
    },

    addNodeView() {
      return ReactNodeViewRenderer(ChipNodeView)
    },
  })
}

/** Live: this plan's `@` trigger (T4) inserts this and only this chip. */
export const ComposerFileChip = createComposerChipNode('composerFileChip')

/** Defined, never inserted in this plan — a later spec's `$` skill trigger. */
export const ComposerSkillChip = createComposerChipNode('composerSkillChip')

/** Defined, never inserted in this plan — a later spec's terminal-context
 *  attachment (subsystem C in the design spec's "Where this sits" table). */
export const ComposerTerminalContextChip = createComposerChipNode('composerTerminalContextChip')

/** All three, for T5 to spread into the editor's extension list. */
export const composerChipNodes = [ComposerFileChip, ComposerSkillChip, ComposerTerminalContextChip]

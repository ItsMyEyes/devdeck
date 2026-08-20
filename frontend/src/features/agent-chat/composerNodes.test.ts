/**
 * Plan T3 — the three composer chip node types
 * (`composerFileChip`, `composerSkillChip`, `composerTerminalContextChip`).
 *
 * Two kinds of coverage:
 *
 * 1. Schema-level (no editor, no DOM): build a minimal inline-only
 *    ProseMirror schema around just these three node extensions — enough for
 *    `getSchema` to assemble a real schema — and assert the design's two
 *    hard requirements (inline, atomic) plus that a node's attrs round-trip
 *    through T1's pure `serializeComposerDoc` exactly the way calling
 *    `composerFileChip(value)` directly would.
 * 2. One real-editor mount, proving the "then implement" half of the task —
 *    `ReactNodeViewRenderer` over T2's `ComposerChip` — actually renders
 *    `ComposerChip`'s markup and wires its remove control to delete the node.
 */
import { createElement, useEffect } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { Node, getSchema } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'

import {
  ComposerFileChip,
  ComposerSkillChip,
  ComposerTerminalContextChip,
  composerChipNodeName,
  composerChipNodeToChip,
  composerChipNodes,
} from '@/features/agent-chat/composerNodes'
import {
  composerFileChip,
  composerSkillChip,
  composerTerminalContextChip,
  composerText,
  serializeComposerDoc,
} from '@/features/agent-chat/composerSerialize'
import type { ComposerDoc } from '@/features/agent-chat/composerSerialize'

// Stand-ins for the real editor's Document/Text extensions (T5's job) — just
// enough inline-only schema shape for `getSchema` to assemble a working
// schema around the three chip nodes under test.
const TestDocument = Node.create({ name: 'doc', topNode: true, content: 'inline*' })
const TestText = Node.create({ name: 'text', group: 'inline' })

const schema = getSchema([TestDocument, TestText, ...composerChipNodes])

function doc(...content: ComposerDoc['content']): ComposerDoc {
  return { type: 'doc', content }
}

afterEach(() => {
  cleanup()
})

describe('composer chip nodes are inline atoms', () => {
  it.each([
    ['composerFileChip'],
    ['composerSkillChip'],
    ['composerTerminalContextChip'],
  ] as const)('%s is inline and atomic', (nodeName) => {
    const nodeType = schema.nodes[nodeName]
    expect(nodeType).toBeDefined()
    expect(nodeType.isInline).toBe(true)
    expect(nodeType.isAtom).toBe(true)
  })

  it('defines all three node types, even though only the file chip is ever inserted in this plan', () => {
    expect(composerChipNodes.map((extension) => extension.name).sort()).toEqual(
      ['composerFileChip', 'composerSkillChip', 'composerTerminalContextChip'].sort(),
    )
  })
})

describe('composerChipNodeName', () => {
  it('maps each T1 chip kind to the node type name that carries it', () => {
    expect(composerChipNodeName('file')).toBe('composerFileChip')
    expect(composerChipNodeName('skill')).toBe('composerSkillChip')
    expect(composerChipNodeName('terminalContext')).toBe('composerTerminalContextChip')
  })
})

describe('composer chip nodes round-trip through T1 serialization', () => {
  it('a composerFileChip node serializes exactly like composerFileChip(value)', () => {
    const node = schema.nodes.composerFileChip.create({ value: 'src/app.tsx' })
    const chip = composerChipNodeToChip(node.toJSON())

    expect(chip).toEqual(composerFileChip('src/app.tsx'))
    expect(serializeComposerDoc(doc(chip))).toBe('[app.tsx](src/app.tsx)')
  })

  it('a composerSkillChip node serializes exactly like composerSkillChip(value)', () => {
    const node = schema.nodes.composerSkillChip.create({ value: 'review' })
    const chip = composerChipNodeToChip(node.toJSON())

    expect(chip).toEqual(composerSkillChip('review'))
    // Was `$review` when the skill chip was defined-but-never-inserted. The
    // spec that turned the `$` trigger on owns making it self-delimiting
    // first, because a bare prefix has no terminator — the same defect that
    // made a file chip swallow the word after it.
    expect(serializeComposerDoc(doc(chip))).toBe('[$review](skill:review)')
  })

  it('a composerTerminalContextChip node serializes exactly like composerTerminalContextChip(value)', () => {
    const node = schema.nodes.composerTerminalContextChip.create({ value: 'terminal-1:12-13' })
    const chip = composerChipNodeToChip(node.toJSON())

    expect(chip).toEqual(composerTerminalContextChip('terminal-1:12-13'))
    // Was `@terminal-1:12-13` while this chip was defined-but-never-inserted.
    // The spec that made it insertable owns delimiting it first — the third
    // and last chip kind to shed a bare prefix, after file and skill.
    expect(serializeComposerDoc(doc(chip))).toBe('[terminal-1:12-13](terminal:terminal-1:12-13)')
  })

  it('carries a custom label without it affecting serialization', () => {
    const node = schema.nodes.composerFileChip.create({ value: 'src/app.tsx', label: 'app.tsx' })
    const chip = composerChipNodeToChip(node.toJSON())

    expect(chip).toEqual(composerFileChip('src/app.tsx', 'app.tsx'))
    expect(serializeComposerDoc(doc(chip))).toBe('[app.tsx](src/app.tsx)')
  })

  it('round-trips inside a full document alongside text nodes', () => {
    const node = schema.nodes.composerFileChip.create({ value: 'src/app.tsx' })
    const chip = composerChipNodeToChip(node.toJSON())
    const composerDoc = doc(composerText('look at '), chip, composerText(' before merging'))

    expect(serializeComposerDoc(composerDoc)).toBe('look at [app.tsx](src/app.tsx) before merging')
  })

  it('throws for a node type that is not one of the three chip kinds', () => {
    expect(() => composerChipNodeToChip({ type: 'text', attrs: {} })).toThrow()
  })
})

// A node view's `ReactRenderer` only draws through the portal registry
// `@tiptap/react`'s own `EditorContent`/`useEditor` set up on the editor
// (`editor.contentComponent`) — a bare `new Editor(...)` from `@tiptap/core`
// never gets one, so its node views build a DOM element but nothing ever
// renders into it. This harness is the minimum that actually exercises
// `ReactNodeViewRenderer`.
function TestEditorHost({ onEditor }: { onEditor: (editor: Editor) => void }) {
  const editor = useEditor({
    extensions: [TestDocument, TestText, ComposerFileChip, ComposerSkillChip, ComposerTerminalContextChip],
    content: {
      type: 'doc',
      content: [{ type: 'composerFileChip', attrs: { value: 'src/app.tsx' } }],
    },
  })

  useEffect(() => {
    if (editor) onEditor(editor)
  }, [editor, onEditor])

  return createElement(EditorContent, { editor })
}

describe('composer chip nodes render via ReactNodeViewRenderer over ComposerChip', () => {
  it('mounts ComposerChip for a composerFileChip node and wires its remove control to delete the node', async () => {
    let capturedEditor: Editor | null = null
    const { container } = render(createElement(TestEditorHost, { onEditor: (editor) => (capturedEditor = editor) }))

    await waitFor(() => {
      expect(container.querySelector('[data-composer-chip-kind="file"]')).not.toBeNull()
    })

    const chipEl = container.querySelector('[data-composer-chip-kind="file"]')
    expect(chipEl?.textContent).toContain('src/app.tsx')

    const removeButton = chipEl?.querySelector('button')
    expect(removeButton).not.toBeNull()
    fireEvent.click(removeButton as HTMLButtonElement)

    await waitFor(() => {
      expect(capturedEditor?.getJSON().content ?? []).toHaveLength(0)
    })
  })
})

/**
 * Plan D3 — the `$` skill trigger (`composerSkillTrigger.ts`).
 *
 * Two kinds of coverage, matching the design spec's Testing section and
 * mirroring D2's `composerMention.test.ts`:
 *
 * 1. Unit, no DOM: `matchSkills` — the pure prefix-then-contains matcher
 *    over an in-memory `AgentSkill[]` snapshot.
 * 2. Real-editor mount (`useEditor`/`EditorContent`, same harness shape as
 *    `composerMention.test.ts`'s `TestEditorHost`): the popup reflects the
 *    catalog snapshot's `loading`/`error`/`ready`-empty states, and
 *    selecting a skill inserts a `composerSkillChip` node.
 */
import { createElement, useEffect } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { Node } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'

import type { AgentSkill } from '@/store/types'
import { ComposerFileChip, ComposerSkillChip, ComposerTerminalContextChip } from '@/features/agent-chat/composerNodes'
import { createComposerSkillTrigger, matchSkills } from '@/features/agent-chat/composerSkillTrigger'
import type { SkillCatalogSnapshot } from '@/features/agent-chat/composerSkillTrigger'

afterEach(cleanup)

function skill(name: string, description = ''): AgentSkill {
  return { name, description, category: 'general', readOnly: false }
}

describe('matchSkills', () => {
  it('returns everything, sorted by name, when the query is empty', () => {
    const skills = [skill('zeta'), skill('alpha'), skill('mu')]
    expect(matchSkills(skills, '').map((s) => s.name)).toEqual(['alpha', 'mu', 'zeta'])
  })

  it('puts prefix hits ahead of contains hits', () => {
    const skills = [skill('code-review'), skill('review-notes'), skill('data-report')]
    expect(matchSkills(skills, 'review').map((s) => s.name)).toEqual(['review-notes', 'code-review'])
  })

  it('matches on description too', () => {
    const skills = [skill('foo', 'reviews pull requests'), skill('bar', 'unrelated')]
    expect(matchSkills(skills, 'review').map((s) => s.name)).toEqual(['foo'])
  })

  it('caps results at 20', () => {
    const skills = Array.from({ length: 25 }, (_, i) => skill(`skill-${String(i).padStart(2, '0')}`))
    expect(matchSkills(skills, '')).toHaveLength(20)
  })
})

// Stand-ins for the real editor's Document/Text extensions — the same
// minimal inline-only schema shape `composerMention.test.ts` builds.
const TestDocument = Node.create({ name: 'doc', topNode: true, content: 'inline*' })
const TestText = Node.create({ name: 'text', group: 'inline' })

function TestEditorHost({
  snapshot,
  onEditor,
}: {
  snapshot: { current: SkillCatalogSnapshot }
  onEditor: (editor: Editor) => void
}) {
  const editor = useEditor({
    extensions: [
      TestDocument,
      TestText,
      ComposerFileChip,
      ComposerSkillChip,
      ComposerTerminalContextChip,
      createComposerSkillTrigger(snapshot),
    ],
    content: { type: 'doc', content: [{ type: 'text', text: 'hello ' }] },
  })
  useEffect(() => {
    if (editor) onEditor(editor)
  }, [editor, onEditor])
  return createElement(EditorContent, { editor })
}

describe('createComposerSkillTrigger — catalog states', () => {
  it('shows Searching… while the catalog is loading', async () => {
    const snapshot = { current: { status: 'loading', skills: [], agentId: 'claude' } as SkillCatalogSnapshot }
    let editor: Editor | null = null
    render(createElement(TestEditorHost, { snapshot, onEditor: (e) => (editor = e) }))
    await waitFor(() => expect(editor).not.toBeNull())
    editor!.commands.focus('end')
    editor!.commands.insertContent('$rev')
    await waitFor(() => expect(document.querySelector('[data-skill-item]')).toBeNull())
    expect(document.body.textContent).toContain('Searching…')
  })

  it("shows the agent-scoped error message when the catalog failed to load", async () => {
    const snapshot = { current: { status: 'error', skills: [], agentId: 'claude' } as SkillCatalogSnapshot }
    let editor: Editor | null = null
    render(createElement(TestEditorHost, { snapshot, onEditor: (e) => (editor = e) }))
    await waitFor(() => expect(editor).not.toBeNull())
    editor!.commands.focus('end')
    editor!.commands.insertContent('$rev')
    await waitFor(() => expect(document.body.textContent).toContain("Couldn't load skills for claude"))
  })

  it('shows "No skills found" for a ready catalog with no matches', async () => {
    const snapshot = {
      current: { status: 'ready', skills: [skill('code-review')], agentId: 'claude' } as SkillCatalogSnapshot,
    }
    let editor: Editor | null = null
    render(createElement(TestEditorHost, { snapshot, onEditor: (e) => (editor = e) }))
    await waitFor(() => expect(editor).not.toBeNull())
    editor!.commands.focus('end')
    editor!.commands.insertContent('$nonexistent')
    await waitFor(() => expect(document.body.textContent).toContain('No skills found'))
  })
})

describe('createComposerSkillTrigger — selection', () => {
  it('selecting a skill inserts a composerSkillChip with the exact skill name as value', async () => {
    const snapshot = {
      current: { status: 'ready', skills: [skill('code-review', 'Reviews a PR')], agentId: 'claude' } as SkillCatalogSnapshot,
    }
    let editor: Editor | null = null
    render(createElement(TestEditorHost, { snapshot, onEditor: (e) => (editor = e) }))
    await waitFor(() => expect(editor).not.toBeNull())
    editor!.commands.focus('end')
    editor!.commands.insertContent('$code')
    await waitFor(() => expect(document.querySelector('[data-skill-item="code-review"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-skill-item="code-review"]') as HTMLButtonElement)
    await waitFor(() => {
      const content = editor!.getJSON().content ?? []
      expect(content.some((n) => n.type === 'composerSkillChip' && n.attrs?.value === 'code-review')).toBe(true)
    })
    expect(editor!.getText()).not.toContain('$code')
  })

  it('$ does not open the menu mid-word (reuses mentionAllow — word-start rule)', async () => {
    const snapshot = { current: { status: 'ready', skills: [skill('review')], agentId: 'claude' } as SkillCatalogSnapshot }
    let editor: Editor | null = null
    render(createElement(TestEditorHost, { snapshot, onEditor: (e) => (editor = e) }))
    await waitFor(() => expect(editor).not.toBeNull())
    editor!.commands.focus('end')
    editor!.commands.insertContent('foo$review') // '$' preceded by 'o', not whitespace
    expect(document.querySelector('[data-skill-item]')).toBeNull()
  })
})

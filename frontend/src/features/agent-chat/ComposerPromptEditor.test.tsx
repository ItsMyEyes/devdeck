/**
 * Plan T5 — `ComposerPromptEditor.tsx`. Component-level tests only (the pure
 * logic underneath — serialization, the `@` `allow` rule — already has its
 * own unit coverage in T1/T4's test files); this file exercises the
 * assembled editor as a black box, exactly the way `ChatComposer` (T6) will
 * use it: through `value`/`onChange`/`onSubmit`/`disabled`/`placeholder` and
 * the rendered DOM, never through an internal editor handle.
 *
 * Two techniques this suite depends on, both verified against this
 * repository's actual `@tiptap`/`prosemirror-view` versions before being
 * relied on here (jsdom does not support real contentEditable typing, so
 * "typing" has to go through a path ProseMirror handles explicitly):
 *
 * 1. `fireEvent.paste` with a fake `clipboardData.getData` — ProseMirror's
 *    `editHandlers.paste` reads `event.clipboardData` synchronously and
 *    dispatches a transaction inserting that text, independent of jsdom's
 *    (nonexistent) native contentEditable behaviour.
 * 2. `fireEvent.keyDown` directly on the `[contenteditable="true"]` node —
 *    `prosemirror-keymap` binds a real `keydown` listener on `view.dom`, so
 *    a synthetic event with the right `key`/`shiftKey` reaches it the same
 *    way a real keystroke would.
 *
 * The mention popup (`composerMention.ts`'s `MentionMenu`) mounts outside
 * the render `container` (via `props.mount`, the same anchoring
 * `composerMention.test.ts` already covers), so assertions on it query
 * `document`, not `container` — mirroring that file's own tests.
 */
import { createElement, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'

import type { Machine } from '@/store/types'
import { searchWorktreeFiles } from '@/lib/machineApi'
import { useAgentSkills } from '@/features/data/queries'

import { ComposerPromptEditor } from '@/features/agent-chat/ComposerPromptEditor'
import type { ComposerPromptEditorHandle, ComposerPromptEditorProps } from '@/features/agent-chat/ComposerPromptEditor'
import { composerTerminalContextChip, serializeComposerDoc } from '@/features/agent-chat/composerSerialize'
import type { ComposerDoc } from '@/features/agent-chat/composerSerialize'

vi.mock('@/lib/machineApi', () => ({
  searchWorktreeFiles: vi.fn(),
}))

// D5's one stated exception (spec Testing section, plan D5 Step 1):
// introducing `useAgentSkills` anywhere in the composer subtree requires a
// mock here, the same lighter touch already used in ChatComposer.test.tsx /
// AgentChatPane.test.tsx.
vi.mock('@/features/data/queries', () => ({
  useAgentSkills: vi.fn(),
}))

const searchWorktreeFilesMock = vi.mocked(searchWorktreeFiles)
const useAgentSkillsMock = vi.mocked(useAgentSkills)

// Default: a ready catalog with one skill, unless a test overrides it.
beforeEach(() => {
  useAgentSkillsMock.mockReturnValue({
    data: [{ name: 'code-review', description: 'Reviews a PR', category: 'general', readOnly: false }],
    isLoading: false,
    error: null,
  } as never)
})

const FAKE_MACHINE: Machine = {
  id: 'machine-1',
  name: 'local',
  url: 'http://localhost:8989',
  key: 'test-key',
  isLocal: true,
  signingPublicKey: 'pub',
}

afterEach(() => {
  cleanup()
  searchWorktreeFilesMock.mockReset()
})

function paste(target: Element, text: string) {
  fireEvent.paste(target, {
    clipboardData: { getData: (type: string) => (type === 'text/plain' ? text : '') },
  })
}

function renderEditor(overrides: Partial<ComposerPromptEditorProps> = {}) {
  const onChange = vi.fn()
  const onSubmit = vi.fn()
  const props: ComposerPromptEditorProps = {
    value: '',
    onChange,
    onSubmit,
    machine: FAKE_MACHINE,
    worktreeId: 'worktree-1',
    agentId: 'claude',
    onInteractionModeChange: vi.fn(),
    ...overrides,
  }
  const utils = render(createElement(ComposerPromptEditor, props))
  const dom = utils.container.querySelector('[contenteditable]') as HTMLElement
  return { ...utils, dom, onChange, onSubmit }
}

/** Last value handed to `onChange`, or `undefined` if it was never called. */
function lastChange(onChange: ReturnType<typeof vi.fn>): string | undefined {
  const calls = onChange.mock.calls
  return calls.length > 0 ? (calls[calls.length - 1]?.[0] as string) : undefined
}

function doc(...content: ComposerDoc['content']): ComposerDoc {
  return { type: 'doc', content }
}

/** The string a terminal-context chip with this value/label serializes to,
 *  derived from `composerSerialize.ts` itself rather than hardcoded here —
 *  this suite exercises `insertChip`, not the serialized *format*, which is
 *  a different task's (T1's) contract and may land before or after this one. */
function serializedTerminalContextChip(value: string, label?: string): string {
  return serializeComposerDoc(doc(composerTerminalContextChip(value, label)))
}

function renderEditorWithRef(overrides: Partial<ComposerPromptEditorProps> = {}) {
  const ref = createRef<ComposerPromptEditorHandle>()
  const onChange = vi.fn()
  const onSubmit = vi.fn()
  const props: ComposerPromptEditorProps = {
    value: '',
    onChange,
    onSubmit,
    machine: FAKE_MACHINE,
    worktreeId: 'worktree-1',
    agentId: 'claude',
    onInteractionModeChange: vi.fn(),
    ...overrides,
  }
  const utils = render(createElement(ComposerPromptEditor, { ...props, ref }))
  return { ...utils, ref, onChange, onSubmit }
}

describe('ComposerPromptEditor — Enter and Shift+Enter', () => {
  it('Enter submits', () => {
    const { dom, onSubmit } = renderEditor({ value: 'hello' })
    fireEvent.keyDown(dom, { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('Shift+Enter inserts a newline and does not submit', async () => {
    const { dom, onChange, onSubmit } = renderEditor()
    paste(dom, 'hello')
    await waitFor(() => expect(lastChange(onChange)).toBe('hello'))

    fireEvent.keyDown(dom, { key: 'Enter', shiftKey: true })

    await waitFor(() => expect(lastChange(onChange)).toContain('\n'))
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('ComposerPromptEditor — @ mention menu', () => {
  it('Enter with the mention menu open selects an item and does NOT submit', async () => {
    searchWorktreeFilesMock.mockResolvedValue(['src/app.tsx'])
    const { dom, onSubmit, onChange } = renderEditor()
    paste(dom, '@app')

    await waitFor(() => {
      expect(searchWorktreeFilesMock).toHaveBeenCalledWith(FAKE_MACHINE, 'worktree-1', 'app', { includeDirs: true })
    })
    await waitFor(() => {
      expect(document.querySelector('[data-mention-item="src/app.tsx"]')).not.toBeNull()
    })

    fireEvent.keyDown(dom, { key: 'Enter' })

    expect(onSubmit).not.toHaveBeenCalled()
    await waitFor(() => expect(lastChange(onChange)).toContain('[app.tsx](src/app.tsx)'))
  })

  it('selecting a file yields a value containing the markdown link for that path', async () => {
    searchWorktreeFilesMock.mockResolvedValue(['src/app.tsx'])
    const { dom, onChange } = renderEditor()
    paste(dom, '@app')

    await waitFor(() => {
      expect(document.querySelector('[data-mention-item="src/app.tsx"]')).not.toBeNull()
    })

    fireEvent.click(document.querySelector('[data-mention-item="src/app.tsx"]') as HTMLButtonElement)

    await waitFor(() => expect(lastChange(onChange)).toContain('[app.tsx](src/app.tsx)'))
    // The literal "@app" query text is gone, replaced by the chip — not left
    // sitting alongside it.
    expect(lastChange(onChange)).not.toContain('@app ')
  })

  // Regression test for Problem §3: `@tiptap/suggestion`'s `allowedPrefixes`
  // defaults to `[' ']`, so a trigger typed right after a Shift+Enter
  // continuation line (which inserts a literal '\n' text character, not a
  // hardBreak node) was discarded before `allow` ever ran. Honestly
  // failing-first per plan D5 Step 1: this was verified by temporarily
  // reverting `composerMention.ts`'s `allowedPrefixes: [' ', '\n']` back to
  // the implicit default, confirming this test failed (searchWorktreeFiles
  // never called), then restoring the fix and confirming it passes.
  it('@ after Shift+Enter opens the mention menu (regression: Problem §3)', async () => {
    const { dom } = renderEditor()
    fireEvent.keyDown(dom, { key: 'Enter', shiftKey: true }) // literal '\n' before the next char
    paste(dom, '@app')
    await waitFor(() => expect(searchWorktreeFilesMock).toHaveBeenCalled())
  })

  it("typing '$' produces literal text and opens no menu", async () => {
    const { dom, onChange } = renderEditor()
    paste(dom, '$skill')

    await waitFor(() => expect(lastChange(onChange)).toBe('$skill'))
    expect(searchWorktreeFilesMock).not.toHaveBeenCalled()
    expect(document.querySelector('[data-mention-item]')).toBeNull()
  })

  it("typing '/' produces literal text and opens no menu", async () => {
    const { dom, onChange } = renderEditor()
    paste(dom, '/help')

    await waitFor(() => expect(lastChange(onChange)).toBe('/help'))
    expect(searchWorktreeFilesMock).not.toHaveBeenCalled()
    expect(document.querySelector('[data-mention-item]')).toBeNull()
  })
})

describe('ComposerPromptEditor — $ skill menu', () => {
  it('typing $ opens the menu; selecting inserts a chip serialized to the bracketed form', async () => {
    const { dom, onChange } = renderEditor()
    paste(dom, '$code')
    await waitFor(() => expect(document.querySelector('[data-skill-item="code-review"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-skill-item="code-review"]') as HTMLButtonElement)
    await waitFor(() => expect(lastChange(onChange)).toContain('[$code-review](skill:code-review)'))
  })

  it('Enter with the skill menu open selects an item and does NOT submit', async () => {
    const { dom, onSubmit } = renderEditor()
    paste(dom, '$code')
    await waitFor(() => expect(document.querySelector('[data-skill-item="code-review"]')).not.toBeNull())
    fireEvent.keyDown(dom, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('renders the three catalog states', async () => {
    useAgentSkillsMock.mockReturnValue({ data: undefined, isLoading: true, error: null } as never)
    const { dom, rerender } = renderEditor()
    paste(dom, '$x')
    await waitFor(() => expect(document.body.textContent).toContain('Searching…'))

    // The catalog settles to an error while the menu is already open. The
    // live `skillCatalog` ref picks up the new status the moment React
    // re-renders `ComposerPromptEditor` (`rerender` below) — but
    // `@tiptap/suggestion`'s own popup only repaints on its *own* next
    // query-changing transaction: its `apply()` diffs query/text/range by
    // value against the previous plugin state (verified by reading
    // `node_modules/@tiptap/suggestion/dist/index.js`'s `update()`), so a
    // bare React re-render with no further keystroke leaves the mounted
    // popup showing its stale props. The extra `paste` below is not
    // incidental — it is what actually exercises the live ref, the same way
    // a real user who keeps typing while the fetch resolves would.
    useAgentSkillsMock.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') } as never)
    rerender(
      createElement(ComposerPromptEditor, {
        value: '$x',
        onChange: vi.fn(),
        onSubmit: vi.fn(),
        machine: FAKE_MACHINE,
        worktreeId: 'worktree-1',
        agentId: 'claude',
        onInteractionModeChange: vi.fn(),
      }),
    )
    paste(dom, 'y')
    await waitFor(() => expect(document.body.textContent).toContain("Couldn't load skills for claude"))
  })
})

describe('ComposerPromptEditor — / command menu', () => {
  it('typing /pl and pressing Enter calls onInteractionModeChange("plan"), sends nothing, leaves the doc empty', async () => {
    const onInteractionModeChange = vi.fn()
    const { dom, onSubmit, onChange } = renderEditor({ onInteractionModeChange })
    paste(dom, '/pl')
    await waitFor(() => expect(document.querySelector('[data-command-item="plan"]')).not.toBeNull())
    fireEvent.keyDown(dom, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onInteractionModeChange).toHaveBeenCalledWith('plan')
    await waitFor(() => expect(lastChange(onChange)).toBe(''))
  })
})

describe('ComposerPromptEditor — placeholder and disabled', () => {
  it('shows the placeholder only while the value is empty', () => {
    const { rerender, getByText, queryByText, onChange, onSubmit } = (() => {
      const onChange = vi.fn()
      const onSubmit = vi.fn()
      const utils = render(
        createElement(ComposerPromptEditor, {
          value: '',
          onChange,
          onSubmit,
          machine: FAKE_MACHINE,
          worktreeId: 'worktree-1',
          agentId: 'claude',
          onInteractionModeChange: vi.fn(),
          placeholder: 'Ask anything…',
        }),
      )
      return { ...utils, onChange, onSubmit }
    })()

    expect(getByText('Ask anything…')).toBeTruthy()

    rerender(
      createElement(ComposerPromptEditor, {
        value: 'hello',
        onChange,
        onSubmit,
        machine: FAKE_MACHINE,
        worktreeId: 'worktree-1',
        agentId: 'claude',
        onInteractionModeChange: vi.fn(),
        placeholder: 'Ask anything…',
      }),
    )

    expect(queryByText('Ask anything…')).toBeNull()
  })

  it('disabled makes the editor non-editable and Enter does not submit', () => {
    const { dom, onSubmit } = renderEditor({ value: 'hello', disabled: true })
    expect(dom.getAttribute('contenteditable')).toBe('false')
    fireEvent.keyDown(dom, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

// Plan T14 — the imperative `insertChip` ref. `ExpandedTerminal.tsx`'s "Send
// to chat" bridge (T15) is the real caller; this suite drives the ref
// directly, the same way `Terminal.test.tsx` drives `captureSelection`.
describe('ComposerPromptEditor — ref.insertChip', () => {
  it('inserts a terminalContext chip node and fires onChange with a value containing its serialized form', async () => {
    const { ref, onChange } = renderEditorWithRef()

    act(() => {
      ref.current?.insertChip('terminalContext', 'sess-1/L1-L2', 'Terminal 1 lines 1-2')
    })

    const expected = serializedTerminalContextChip('sess-1/L1-L2', 'Terminal 1 lines 1-2')
    await waitFor(() => expect(lastChange(onChange)).toContain(expected))
    expect(document.querySelector('[data-composer-chip-kind="terminal-context"]')).not.toBeNull()
  })

  // The trap the plan names directly: the external-value effect
  // (`ComposerPromptEditor.tsx`'s `lastValue.current === value` guard) must
  // not clobber a chip that `insertChip` just put in the document. `insertChip`
  // goes through `editor.commands`, which fires the same `onUpdate` → `onChange`
  // path plain typing does, so `lastValue.current` already agrees with the
  // value the parent re-renders with below — if it didn't, this re-render
  // would call `setContent(parseComposerText(value))`, which never
  // reconstructs chips, and the chip element would vanish from the DOM.
  it('does not clobber the inserted chip when the parent re-renders with the value it just echoed back', async () => {
    const { ref, onChange, rerender } = renderEditorWithRef()

    act(() => {
      ref.current?.insertChip('terminalContext', 'sess-1/L1-L2', 'Terminal 1 lines 1-2')
    })

    const insertedValue = await waitFor(() => {
      const value = lastChange(onChange)
      expect(value).toBeTruthy()
      return value as string
    })

    rerender(
      createElement(ComposerPromptEditor, {
        ref,
        value: insertedValue,
        onChange,
        onSubmit: vi.fn(),
        machine: FAKE_MACHINE,
        worktreeId: 'worktree-1',
        agentId: 'claude',
        onInteractionModeChange: vi.fn(),
      }),
    )

    expect(document.querySelector('[data-composer-chip-kind="terminal-context"]')).not.toBeNull()
    expect(document.body.textContent).not.toContain(insertedValue)
  })

  it('removing the inserted chip updates value to no longer contain its serialized form', async () => {
    const { ref, onChange } = renderEditorWithRef()

    act(() => {
      ref.current?.insertChip('terminalContext', 'sess-1/L1-L2', 'Terminal 1 lines 1-2')
    })

    const chipSerialized = serializedTerminalContextChip('sess-1/L1-L2', 'Terminal 1 lines 1-2')
    await waitFor(() => expect(lastChange(onChange)).toContain(chipSerialized))

    const removeButton = document
      .querySelector('[data-composer-chip-kind="terminal-context"]')
      ?.querySelector('button')
    expect(removeButton).toBeTruthy()
    fireEvent.click(removeButton as HTMLButtonElement)

    await waitFor(() => expect(lastChange(onChange)).not.toContain(chipSerialized))
  })
})

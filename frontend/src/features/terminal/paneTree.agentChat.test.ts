/**
 * `paneTree.test.ts` is the pre-Vitest `check()`-harness file (see its own
 * header comment) and is deliberately excluded from `vite.config.ts`'s test
 * `include` allowlist, so appending Vitest `describe`/`it` blocks there would
 * never run. `paneTree.stats.test.ts` set the precedent for testing a new
 * pane-content kind's factory in its own sibling file instead — this file
 * follows that same convention for `createAgentChatPane`.
 */
import { describe, expect, it } from 'vitest'
import { createAgentChatPane } from './paneTree'

describe('createAgentChatPane', () => {
  it('uses the bare worktree id for the primary chat, mirroring terminal panes', () => {
    const pane = createAgentChatPane('w-abc')
    expect(pane.kind).toBe('agent-chat')
    expect(pane.id).toBe('w-abc')
    expect(pane.threadKey).toBe('w-abc')
    expect(pane.label).toBe('Chat')
  })

  it('suffixes additional chat panes so each gets its own thread', () => {
    const pane = createAgentChatPane('w-abc', 1)
    expect(pane.id).toBe('w-abc::chat-1')
    expect(pane.threadKey).toBe('w-abc::chat-1')
    expect(pane.label).toBe('Chat 2')
  })
})

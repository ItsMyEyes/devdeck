import { describe, expect, it } from 'vitest'
import { EMPTY_THREAD_VIEW, emptyThreadView, reduceAgentEvents } from '@/features/agent-chat/eventReducer'
import type { AgentEvent } from '@/features/agent-chat/types'

function delta(seq: number, itemId: string, text: string, sequence: number, stream = 'text'): AgentEvent {
  return {
    seq,
    eventId: `ae-${seq}`,
    type: 'thread.activity-appended',
    threadId: 'w-abc',
    commandId: `ac-${seq}`,
    createdAt: 1000,
    payload: { itemId, stream, text, sequence },
  }
}

describe('reduceAgentEvents', () => {
  it('appends deltas into a single assistant item', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      delta(1, 'i1', 'Hello ', 1),
      delta(2, 'i1', 'world', 2),
    ])
    expect(view.items).toHaveLength(1)
    expect(view.items[0].kind).toBe('assistant')
    expect(view.items[0].text).toBe('Hello world')
    expect(view.lastSeq).toBe(2)
  })

  it('keeps reasoning in a separate item from the answer', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      delta(1, 'i1', 'thinking...', 1, 'reasoning'),
      delta(2, 'i2', 'the answer', 1, 'text'),
    ])
    expect(view.items.map((i) => i.kind)).toEqual(['reasoning', 'assistant'])
  })

  // The client cannot re-order what the server already ordered by Seq, but a
  // gap in the per-item sequence means a delta was genuinely lost.
  it('flags a sequence gap rather than silently concatenating', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      delta(1, 'i1', 'Hello ', 1),
      delta(2, 'i1', 'world', 5),
    ])
    expect(view.hasGap).toBe(true)
  })

  it('ignores an event already applied, so replay overlap is harmless', () => {
    const first = reduceAgentEvents(emptyThreadView(), [delta(1, 'i1', 'Hello', 1)])
    const second = reduceAgentEvents(first, [delta(1, 'i1', 'Hello', 1)])
    expect(second.items[0].text).toBe('Hello')
    expect(second.lastSeq).toBe(1)
  })

  it('is pure — the input view is not mutated', () => {
    const before = emptyThreadView()
    reduceAgentEvents(before, [delta(1, 'i1', 'Hello', 1)])
    expect(before.items).toHaveLength(0)
    expect(before.lastSeq).toBe(0)
  })
})

// Regression: `emptyThreadView()` was used as the fallback INSIDE a zustand
// selector, which returns a new object on every store read while the thread is
// absent. zustand compares with Object.is, so that reads as "changed" every
// time and re-renders forever — React error #185, on every mount of a chat
// pane with no events yet. The fallback must be a stable shared reference.
describe('EMPTY_THREAD_VIEW', () => {
  it('is referentially stable across reads', () => {
    expect(EMPTY_THREAD_VIEW).toBe(EMPTY_THREAD_VIEW)
  })

  it('is NOT the same reference emptyThreadView() returns', () => {
    expect(emptyThreadView()).not.toBe(EMPTY_THREAD_VIEW)
    expect(emptyThreadView()).toEqual(EMPTY_THREAD_VIEW)
  })

  it('is frozen, so a stray mutation fails loudly instead of corrupting every thread', () => {
    expect(Object.isFrozen(EMPTY_THREAD_VIEW)).toBe(true)
  })

  it('survives being reduced against without being mutated', () => {
    const next = reduceAgentEvents(EMPTY_THREAD_VIEW, [delta(1, 'i1', 'Hello', 1)])
    expect(next).not.toBe(EMPTY_THREAD_VIEW)
    expect(EMPTY_THREAD_VIEW.items).toHaveLength(0)
    expect(EMPTY_THREAD_VIEW.lastSeq).toBe(0)
  })
})

// Regression: the reducer only built items from payloads shaped
// {itemId, stream, text, sequence} — assistant text deltas. Everything else
// advanced lastSeq and produced NO item, so a live thread rendered "No
// messages yet" forever: your own message never appeared, and neither did any
// tool call. Three of ChatItemKind's five values were unreachable.
function userMessage(seq: number, text: string): AgentEvent {
  return {
    seq,
    eventId: `ae-${seq}`,
    type: 'thread.message-sent',
    threadId: 'w-abc',
    commandId: `ac-${seq}`,
    createdAt: 1000,
    payload: { text, model: { instanceId: 'claude:default', model: 'claude-sonnet-5' } },
  }
}

/** Ingestion's fallback forwards the whole canonical provider event verbatim
 *  as the activity-appended payload — this is the shape a tool call arrives
 *  in, and what the reducer used to drop on the floor. */
function forwardedEvent(seq: number, providerType: string, itemId: string, inner: unknown): AgentEvent {
  return {
    seq,
    eventId: `ae-${seq}`,
    type: 'thread.activity-appended',
    threadId: 'w-abc',
    commandId: `ac-${seq}`,
    createdAt: 1000,
    payload: { eventId: `pe-${seq}`, type: providerType, threadId: 'w-abc', itemId, payload: inner },
  }
}

describe('reduceAgentEvents — non-delta events', () => {
  it('renders the user’s own message', () => {
    const view = reduceAgentEvents(EMPTY_THREAD_VIEW, [userMessage(1, 'fix the auth redirect')])
    expect(view.items).toHaveLength(1)
    expect(view.items[0].kind).toBe('user')
    expect(view.items[0].text).toBe('fix the auth redirect')
  })

  it('renders a tool call as a tool row', () => {
    const view = reduceAgentEvents(EMPTY_THREAD_VIEW, [
      forwardedEvent(1, 'item.started', 'i1', { itemType: 'tool_call', title: 'Read src/auth.ts' }),
    ])
    expect(view.items).toHaveLength(1)
    expect(view.items[0].kind).toBe('tool')
    expect(view.items[0].toolName).toBe('Read src/auth.ts')
    expect(view.items[0].status).toBe('running')
  })

  it('completes a tool row in place rather than stacking a second one', () => {
    let view = reduceAgentEvents(EMPTY_THREAD_VIEW, [
      forwardedEvent(1, 'item.started', 'i1', { itemType: 'tool_call', title: 'Read src/auth.ts' }),
    ])
    view = reduceAgentEvents(view, [
      forwardedEvent(2, 'item.completed', 'i1', { itemType: 'tool_call', status: 'done' }),
    ])
    expect(view.items).toHaveLength(1)
    expect(view.items[0].status).toBe('done')
  })

  it('renders a runtime error as an error row', () => {
    const view = reduceAgentEvents(EMPTY_THREAD_VIEW, [
      forwardedEvent(1, 'runtime.error', 'e1', { message: 'claude exited with code 1' }),
    ])
    expect(view.items).toHaveLength(1)
    expect(view.items[0].kind).toBe('error')
    expect(view.items[0].text).toContain('claude exited with code 1')
  })

  it('interleaves a whole turn in order', () => {
    const view = reduceAgentEvents(EMPTY_THREAD_VIEW, [
      userMessage(1, 'fix it'),
      forwardedEvent(2, 'item.started', 'i1', { itemType: 'tool_call', title: 'Read' }),
      delta(3, 'i2', 'I found ', 1),
      delta(4, 'i2', 'the bug', 2),
    ])
    expect(view.items.map((i) => i.kind)).toEqual(['user', 'tool', 'assistant'])
    expect(view.items[2].text).toBe('I found the bug')
  })
})

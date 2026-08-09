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

describe('reduceAgentEvents — tool detail and timestamps', () => {
  /** A forwarded provider `item.started` for a tool call. The outer event is
   *  an orchestration `thread.activity-appended`; the provider's own envelope
   *  rides in its payload. See applyForwarded's doc comment. */
  function toolStarted(seq: number, itemId: string, name: string): AgentEvent {
    return {
      seq,
      eventId: `e-${seq}`,
      type: 'thread.activity-appended',
      threadId: 't-1',
      commandId: `c-${seq}`,
      createdAt: 1_700_000_000_000 + seq * 1000,
      payload: {
        type: 'item.started',
        itemId,
        payload: { itemType: 'tool_call', title: name, detail: { toolCallId: 'tc_42', name } },
      },
    }
  }

  function toolCompleted(seq: number, itemId: string, input: unknown): AgentEvent {
    return {
      seq,
      eventId: `e-${seq}`,
      type: 'thread.activity-appended',
      threadId: 't-1',
      commandId: `c-${seq}`,
      createdAt: 1_700_000_000_000 + seq * 1000,
      payload: {
        type: 'item.completed',
        itemId,
        payload: { itemType: 'tool_call', status: 'completed', detail: input },
      },
    }
  }

  it('keeps the toolCallId from the started event', () => {
    const view = reduceAgentEvents(emptyThreadView(), [toolStarted(1, 'i-1', 'Edit')])
    expect(view.items[0].toolCallId).toBe('tc_42')
  })

  it('keeps the tool input from the completed event', () => {
    const started = reduceAgentEvents(emptyThreadView(), [toolStarted(1, 'i-1', 'Edit')])
    const view = reduceAgentEvents(started, [toolCompleted(2, 'i-1', { file_path: '/a/b.go' })])
    expect(view.items).toHaveLength(1)
    expect(view.items[0].input).toEqual({ file_path: '/a/b.go' })
    expect(view.items[0].status).toBe('done')
  })

  it('does not clobber an input already folded in when a later event carries none', () => {
    const withInput = reduceAgentEvents(emptyThreadView(), [
      toolStarted(1, 'i-1', 'Edit'),
      toolCompleted(2, 'i-1', { file_path: '/a/b.go' }),
    ])
    const view = reduceAgentEvents(withInput, [
      {
        seq: 3,
        eventId: 'e-3',
        type: 'thread.activity-appended',
        threadId: 't-1',
        commandId: 'c-3',
        createdAt: 1_700_000_003_000,
        payload: { type: 'item.completed', itemId: 'i-1', payload: { itemType: 'tool_call', status: 'completed' } },
      },
    ])
    expect(view.items[0].input).toEqual({ file_path: '/a/b.go' })
  })

  it('stamps every item with the event createdAt', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      {
        seq: 1,
        eventId: 'e-1',
        type: 'thread.message-sent',
        threadId: 't-1',
        commandId: 'c-1',
        createdAt: 1_700_000_000_000,
        payload: { text: 'hello' },
      },
      toolStarted(2, 'i-1', 'Read'),
    ])
    expect(view.items[0].createdAt).toBe(1_700_000_000_000)
    expect(view.items[1].createdAt).toBe(1_700_000_002_000)
  })

  it('stamps an assistant delta item with the createdAt of its first chunk', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      {
        seq: 1,
        eventId: 'e-1',
        type: 'thread.activity-appended',
        threadId: 't-1',
        commandId: 'c-1',
        createdAt: 1_700_000_005_000,
        payload: { itemId: 'a-1', stream: 'text', text: 'partial', sequence: 1 },
      },
      {
        seq: 2,
        eventId: 'e-2',
        type: 'thread.activity-appended',
        threadId: 't-1',
        commandId: 'c-2',
        createdAt: 1_700_000_009_000,
        payload: { itemId: 'a-1', stream: 'text', text: ' more', sequence: 2 },
      },
    ])
    expect(view.items).toHaveLength(1)
    expect(view.items[0].text).toBe('partial more')
    expect(view.items[0].createdAt).toBe(1_700_000_005_000)
  })

  it('records an error row with its timestamp', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      {
        seq: 1,
        eventId: 'e-1',
        type: 'thread.activity-appended',
        threadId: 't-1',
        commandId: 'c-1',
        createdAt: 1_700_000_011_000,
        payload: { type: 'runtime.error', payload: { message: 'claude exited 1' } },
      },
    ])
    expect(view.items[0].kind).toBe('error')
    expect(view.items[0].createdAt).toBe(1_700_000_011_000)
  })
})

// Regression: `view.status` was never written by this reducer, so it stayed
// 'idle' for a thread's whole life even though the backend already puts the
// status on the wire (`thread.session-set`, dispatched by Ingestion for
// SessionStarted / TurnCompleted / SessionExited / RequestOpened, plus
// `thread.turn-start-requested` which the projector treats as "running").
// Everything downstream that reads it — the composer's interrupt control, the
// reasoning shimmer, and the "don't stamp a turn that is still running" guard
// — was therefore dead.
describe('reduceAgentEvents — thread status', () => {
  function sessionSet(seq: number, payload: unknown): AgentEvent {
    return {
      seq,
      eventId: `se-${seq}`,
      type: 'thread.session-set',
      threadId: 't-1',
      commandId: `sc-${seq}`,
      createdAt: 1_700_000_000_000 + seq * 1000,
      payload,
    }
  }

  function turnStartRequested(seq: number): AgentEvent {
    return {
      seq,
      eventId: `ts-${seq}`,
      type: 'thread.turn-start-requested',
      threadId: 't-1',
      commandId: `tc-${seq}`,
      createdAt: 1_700_000_000_000 + seq * 1000,
      payload: { text: 'go', model: { instanceId: 'claude:default', model: 'claude-sonnet-5' } },
    }
  }

  it('folds a running session into the view status', () => {
    const view = reduceAgentEvents(emptyThreadView(), [sessionSet(1, { status: 'running' })])
    expect(view.status).toBe('running')
  })

  it('marks the thread running the moment the turn start is requested', () => {
    const view = reduceAgentEvents(emptyThreadView(), [turnStartRequested(1)])
    expect(view.status).toBe('running')
  })

  it('folds waiting-on-the-user and back to idle', () => {
    let view = reduceAgentEvents(emptyThreadView(), [turnStartRequested(1)])
    view = reduceAgentEvents(view, [sessionSet(2, { status: 'waiting', pendingRequestAdd: 'r-1' })])
    expect(view.status).toBe('waiting')
    view = reduceAgentEvents(view, [sessionSet(3, { status: 'idle' })])
    expect(view.status).toBe('idle')
  })

  it('folds a dead session as stopped', () => {
    const view = reduceAgentEvents(emptyThreadView(), [sessionSet(1, { status: 'stopped' })])
    expect(view.status).toBe('stopped')
  })

  // SessionStarted's payload also carries `resumeCursor`; a session-set that
  // carries only that must not reset the status the thread already has.
  it('keeps the current status when a session-set carries no status', () => {
    let view = reduceAgentEvents(emptyThreadView(), [sessionSet(1, { status: 'running' })])
    view = reduceAgentEvents(view, [sessionSet(2, { resumeCursor: { sessionId: 'abc' } })])
    expect(view.status).toBe('running')
  })

  it('ignores a status this client does not know', () => {
    let view = reduceAgentEvents(emptyThreadView(), [sessionSet(1, { status: 'running' })])
    view = reduceAgentEvents(view, [sessionSet(2, { status: 'hyperdrive' })])
    expect(view.status).toBe('running')
  })

  it('does not treat a session-set as a chat item', () => {
    const view = reduceAgentEvents(emptyThreadView(), [sessionSet(1, { status: 'running' })])
    expect(view.items).toHaveLength(0)
    expect(view.lastSeq).toBe(1)
  })

  it('leaves the status alone on a replayed event it already applied', () => {
    const first = reduceAgentEvents(emptyThreadView(), [sessionSet(1, { status: 'running' }), sessionSet(2, { status: 'idle' })])
    const second = reduceAgentEvents(first, [sessionSet(1, { status: 'running' })])
    expect(second.status).toBe('idle')
  })
})

// Regression: a turn's footer read `2:40:03 PM • 3s` for a 47-second turn,
// because the only timestamp an item carried was the one it was CREATED with
// — for a streamed assistant message, its time-to-first-token. `updatedAt` is
// the other end of that span.
describe('reduceAgentEvents — updatedAt', () => {
  function delta(seq: number, itemId: string, text: string, sequence: number, createdAt: number): AgentEvent {
    return {
      seq,
      eventId: `de-${seq}`,
      type: 'thread.activity-appended',
      threadId: 't-1',
      commandId: `dc-${seq}`,
      createdAt,
      payload: { itemId, stream: 'text', text, sequence },
    }
  }

  it('moves updatedAt to the newest chunk while createdAt stays put', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      delta(1, 'a-1', 'part', 1, 1_700_000_003_000),
      delta(2, 'a-1', ' two', 2, 1_700_000_047_000),
    ])
    expect(view.items[0].createdAt).toBe(1_700_000_003_000)
    expect(view.items[0].updatedAt).toBe(1_700_000_047_000)
  })

  it('stamps a brand-new item with updatedAt equal to createdAt', () => {
    const view = reduceAgentEvents(emptyThreadView(), [delta(1, 'a-1', 'part', 1, 1_700_000_003_000)])
    expect(view.items[0].updatedAt).toBe(1_700_000_003_000)
  })

  it('moves updatedAt when a tool call completes', () => {
    const started = reduceAgentEvents(emptyThreadView(), [toolStartedAt(1, 'i-1', 'Bash', 1_700_000_005_000)])
    const view = reduceAgentEvents(started, [toolCompletedAt(2, 'i-1', 1_700_000_040_000)])
    expect(view.items[0].createdAt).toBe(1_700_000_005_000)
    expect(view.items[0].updatedAt).toBe(1_700_000_040_000)
  })

  it('stamps the user message and an error row too', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      {
        seq: 1,
        eventId: 'e-1',
        type: 'thread.message-sent',
        threadId: 't-1',
        commandId: 'c-1',
        createdAt: 1_700_000_000_000,
        payload: { text: 'hello' },
      },
      {
        seq: 2,
        eventId: 'e-2',
        type: 'thread.activity-appended',
        threadId: 't-1',
        commandId: 'c-2',
        createdAt: 1_700_000_011_000,
        payload: { type: 'runtime.error', payload: { message: 'boom' } },
      },
    ])
    expect(view.items[0].updatedAt).toBe(1_700_000_000_000)
    expect(view.items[1].updatedAt).toBe(1_700_000_011_000)
  })
})

function toolStartedAt(seq: number, itemId: string, name: string, createdAt: number): AgentEvent {
  return {
    seq,
    eventId: `e-${seq}`,
    type: 'thread.activity-appended',
    threadId: 't-1',
    commandId: `c-${seq}`,
    createdAt,
    payload: { type: 'item.started', itemId, payload: { itemType: 'tool_call', title: name, detail: { toolCallId: 'tc_1', name } } },
  }
}

function toolCompletedAt(seq: number, itemId: string, createdAt: number): AgentEvent {
  return {
    seq,
    eventId: `e-${seq}`,
    type: 'thread.activity-appended',
    threadId: 't-1',
    commandId: `c-${seq}`,
    createdAt,
    payload: { type: 'item.completed', itemId, payload: { itemType: 'tool_call', status: 'completed', detail: { command: 'go test ./...' } } },
  }
}

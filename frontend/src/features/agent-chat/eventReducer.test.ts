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

  // The wire shape is the same TurnStartPayload object EvtThreadMessageSent
  // echoes back — field names match provider.Attachment's JSON tags exactly
  // (id/kind/mime/name, not mimeType).
  it('folds attachments from a message-sent event onto the created item', () => {
    const view = reduceAgentEvents(EMPTY_THREAD_VIEW, [
      {
        seq: 1,
        eventId: 'e1',
        type: 'thread.message-sent',
        threadId: 'w-abc',
        commandId: 'c1',
        createdAt: 1000,
        payload: {
          text: 'check this screenshot',
          attachments: [{ id: 'att-1', kind: 'image', mime: 'image/png', name: 'shot.png' }],
        },
      },
    ])
    expect(view.items).toHaveLength(1)
    expect(view.items[0].attachments).toEqual([{ id: 'att-1', kind: 'image', mime: 'image/png', name: 'shot.png' }])
  })

  // The existing message-sent-without-attachments case (above) stays
  // unchanged; this asserts the field it never checked: no attachments key
  // present means undefined, not an empty array.
  it('leaves attachments undefined when the message carried none', () => {
    const view = reduceAgentEvents(EMPTY_THREAD_VIEW, [userMessage(1, 'fix the auth redirect')])
    expect(view.items[0].attachments).toBeUndefined()
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

  // ── pi's envelope (`provider/pi/parse.go`'s `toolDetail`) ──
  //
  // Regression: this reducer was written against claude's shape only —
  // arguments as the whole `item.completed` detail, nothing on `item.started`.
  // pi inverts it: `{toolCallId,name,args}` started, `{toolCallId,name,result}`
  // completed. Reading the second as arguments put the RESULT in `input`, and
  // `toolSummary` then picked `name` out of it — which is why every pi tool row
  // rendered as `bash bash` and expanded to a result envelope.
  describe('pi tool envelopes', () => {
    function piStarted(seq: number, itemId: string, name: string, args: unknown): AgentEvent {
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
          payload: { itemType: 'tool_call', title: name, detail: { toolCallId: 'call_os78', name, args } },
        },
      }
    }

    it('takes the arguments off item.started, where pi puts them', () => {
      const view = reduceAgentEvents(emptyThreadView(), [piStarted(1, 'i-1', 'bash', { command: 'ssh dev2 uname -a' })])
      expect(view.items[0].input).toEqual({ command: 'ssh dev2 uname -a' })
      expect(view.items[0].toolCallId).toBe('call_os78')
    })

    it('stores the result separately instead of overwriting the arguments with it', () => {
      const result = { content: [{ type: 'text', text: 'Linux dev2' }] }
      const view = reduceAgentEvents(emptyThreadView(), [
        piStarted(1, 'i-1', 'bash', { command: 'ssh dev2 uname -a' }),
        toolCompleted(2, 'i-1', { toolCallId: 'call_os78', name: 'bash', result }),
      ])
      expect(view.items).toHaveLength(1)
      expect(view.items[0].input).toEqual({ command: 'ssh dev2 uname -a' })
      expect(view.items[0].output).toEqual(result)
      expect(view.items[0].status).toBe('done')
    })

    it("never reads claude's bare started envelope as arguments", () => {
      // `{toolCallId, name}` with no `args` is claude announcing a call, not a
      // tool whose one argument happens to be called `name` — reading it as the
      // latter is what produced the duplicated `bash bash` label.
      const view = reduceAgentEvents(emptyThreadView(), [toolStarted(1, 'i-1', 'Edit')])
      expect(view.items[0].input).toBeUndefined()
      expect(view.items[0].output).toBeUndefined()
    })
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

  // Regression: TurnCompleted's usage report was silently dropped end to
  // end — the composer's context-window indicator had nothing to read.
  it('folds contextTokens off the session-set that closes out a turn', () => {
    const view = reduceAgentEvents(emptyThreadView(), [sessionSet(1, { status: 'idle', contextTokens: 47_000 })])
    expect(view.contextTokens).toBe(47_000)
  })

  it('keeps the last reading across turns rather than resetting it', () => {
    let view = reduceAgentEvents(emptyThreadView(), [sessionSet(1, { status: 'idle', contextTokens: 47_000 })])
    view = reduceAgentEvents(view, [turnStartRequested(2)])
    expect(view.contextTokens).toBe(47_000)
    view = reduceAgentEvents(view, [sessionSet(3, { status: 'idle', contextTokens: 62_000 })])
    expect(view.contextTokens).toBe(62_000)
  })

  it('ignores a session-set with no contextTokens field', () => {
    let view = reduceAgentEvents(emptyThreadView(), [sessionSet(1, { status: 'idle', contextTokens: 47_000 })])
    view = reduceAgentEvents(view, [sessionSet(2, { status: 'running' })])
    expect(view.contextTokens).toBe(47_000)
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

describe('per-turn usage', () => {
  // Usage rides on the same `thread.session-set` that closes the turn out, and
  // belongs to that turn — not to the thread — so it lands on the turn's last
  // item, which is where the transcript anchors its stamp.
  it('stamps the turn total and output onto the last item of that turn', () => {
    const start = reduceAgentEvents(emptyThreadView(), [
      { seq: 1, eventId: 'e1', type: 'thread.message-sent', createdAt: 1_000, payload: { text: 'hi' } },
      {
        seq: 2,
        eventId: 'e2',
        type: 'thread.activity-appended',
        createdAt: 2_000,
        payload: { itemId: 'a1', itemType: 'message', role: 'assistant', text: 'yo', sequence: 1 },
      },
    ] as never)

    const done = reduceAgentEvents(start, [
      {
        seq: 3,
        eventId: 'e3',
        type: 'thread.session-set',
        createdAt: 9_000,
        payload: { status: 'idle', contextTokens: 45_000, turnTokens: 12_400, turnOutputTokens: 800 },
      },
    ] as never)

    const last = done.items[done.items.length - 1]
    expect(last.turnTokens).toBe(12_400)
    expect(last.turnOutputTokens).toBe(800)
    // The running occupancy is a separate, thread-level reading.
    expect(done.contextTokens).toBe(45_000)
  })

  it('leaves the items untouched when the event carries no usage', () => {
    const start = reduceAgentEvents(emptyThreadView(), [
      { seq: 1, eventId: 'e1', type: 'thread.message-sent', createdAt: 1_000, payload: { text: 'hi' } },
    ] as never)

    const done = reduceAgentEvents(start, [
      { seq: 2, eventId: 'e2', type: 'thread.session-set', createdAt: 9_000, payload: { status: 'idle' } },
    ] as never)

    expect(done.items[done.items.length - 1].turnTokens).toBeUndefined()
  })
})

describe('an error ends the running state', () => {
  function running() {
    return reduceAgentEvents(emptyThreadView(), [
      { seq: 1, eventId: 'e1', type: 'thread.turn-start-requested', createdAt: 1_000, payload: {} },
    ] as never)
  }

  // The reported trap: a failure in the transcript while the timeline still
  // counted "Working for 1877s" and the composer still showed Stop.
  it('leaves running when a runtime.error arrives', () => {
    const before = running()
    expect(before.status).toBe('running')

    const after = reduceAgentEvents(before, [
      {
        seq: 2,
        eventId: 'e2',
        type: 'thread.activity-appended',
        createdAt: 2_000,
        payload: { type: 'runtime.error', payload: { message: 'provider unreachable' } },
      },
    ] as never)

    expect(after.items[after.items.length - 1]).toMatchObject({ kind: 'error', text: 'provider unreachable' })
    expect(after.status).toBe('idle')
  })

  it('does not disturb the status when the event is not an error', () => {
    const after = reduceAgentEvents(running(), [
      {
        seq: 2,
        eventId: 'e2',
        type: 'thread.activity-appended',
        createdAt: 2_000,
        payload: { itemId: 'a1', itemType: 'message', role: 'assistant', text: 'hi', sequence: 1 },
      },
    ] as never)

    expect(after.status).toBe('running')
  })
})

function userInputRequestedEvent(seq: number, requestId: string): AgentEvent {
  return {
    seq, eventId: `e${seq}`, type: 'thread.activity-appended', threadId: 't1', commandId: `c${seq}`,
    createdAt: seq * 1000,
    payload: {
      type: 'user-input.requested', requestId, threadId: 't1',
      payload: { questions: [{ id: 'q1', header: 'H', question: 'Q?', options: [], multiSelect: false }] },
    },
  }
}
function userInputResolvedEvent(seq: number, requestId: string): AgentEvent {
  return {
    seq, eventId: `e${seq}`, type: 'thread.activity-appended', threadId: 't1', commandId: `c${seq}`,
    createdAt: seq * 1000,
    payload: { type: 'user-input.resolved', requestId, threadId: 't1' },
  }
}

describe('reduceAgentEvents — pendingUserInputs', () => {
  it('user-input.requested opens a pending request', () => {
    const view = reduceAgentEvents(emptyThreadView(), [userInputRequestedEvent(1, 'req-1')])
    expect(view.pendingUserInputs).toHaveLength(1)
    expect(view.pendingUserInputs[0].requestId).toBe('req-1')
    expect(view.pendingUserInputs[0].questions[0].id).toBe('q1')
  })

  it('user-input.resolved closes it', () => {
    const opened = reduceAgentEvents(emptyThreadView(), [userInputRequestedEvent(1, 'req-1')])
    const closed = reduceAgentEvents(opened, [userInputResolvedEvent(2, 'req-1')])
    expect(closed.pendingUserInputs).toHaveLength(0)
  })

  it('a replayed tail re-delivering both is idempotent', () => {
    const first = reduceAgentEvents(emptyThreadView(), [userInputRequestedEvent(1, 'req-1'), userInputResolvedEvent(2, 'req-1')])
    const replayed = reduceAgentEvents(first, [userInputRequestedEvent(1, 'req-1'), userInputResolvedEvent(2, 'req-1')])
    expect(replayed).toBe(first) // seq <= lastSeq short-circuits, same reference
    expect(replayed.pendingUserInputs).toHaveLength(0)
  })

  it('two open requests preserve arrival order', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      userInputRequestedEvent(1, 'req-1'),
      userInputRequestedEvent(2, 'req-2'),
    ])
    expect(view.pendingUserInputs.map((p) => p.requestId)).toEqual(['req-1', 'req-2'])
  })
})

function requestOpenedEvent(seq: number, requestId: string): AgentEvent {
  return {
    seq, eventId: `e${seq}`, type: 'thread.activity-appended', threadId: 't1', commandId: `c${seq}`,
    createdAt: seq * 1000,
    payload: {
      type: 'request.opened', requestId, threadId: 't1',
      payload: { requestType: 'command_execution_approval', detail: 'rm -rf /tmp/x', options: ['accept', 'decline', 'cancel'] },
    },
  }
}
function requestResolvedEvent(seq: number, requestId: string): AgentEvent {
  return {
    seq, eventId: `e${seq}`, type: 'thread.activity-appended', threadId: 't1', commandId: `c${seq}`,
    createdAt: seq * 1000,
    payload: { type: 'request.resolved', requestId, threadId: 't1', payload: { requestType: 'command_execution_approval', decision: 'accept' } },
  }
}

function planProposedEvent(seq: number, planMarkdown: string, toolUseId?: string): AgentEvent {
  return {
    seq,
    eventId: `pe-${seq}`,
    type: 'thread.plan-proposed',
    threadId: 't-1',
    commandId: `pc-${seq}`,
    createdAt: seq * 1000,
    payload: { planMarkdown, toolUseId },
  }
}

describe('reduceAgentEvents — proposed plan', () => {
  it('folds a thread.plan-proposed event into one plan item', () => {
    const view = reduceAgentEvents(emptyThreadView(), [planProposedEvent(1, '# Plan\n\ndo the thing', 'tu-1')])
    expect(view.items).toHaveLength(1)
    expect(view.items[0].kind).toBe('plan')
    expect(view.items[0].text).toBe('# Plan\n\ndo the thing')
  })

  it('keys the item by toolUseId when present', () => {
    const view = reduceAgentEvents(emptyThreadView(), [planProposedEvent(1, 'plan A', 'tu-1')])
    expect(view.items[0].id).toBe('tu-1')
  })

  it('falls back to eventId when no toolUseId is present', () => {
    const view = reduceAgentEvents(emptyThreadView(), [planProposedEvent(1, 'plan B')])
    expect(view.items[0].id).toBe('pe-1')
  })

  // The dedupe key is toolUseId, not seq — a redelivery of the same plan
  // under a fresh seq (e.g. a reconnect window that is not a pure tail
  // overlap) must still fold into the SAME item rather than a second one.
  // This is the same idempotency contract `applyForwarded` already gives the
  // tool path via its `idx === -1` check.
  it('replaying the identical plan under a different seq still produces exactly one item', () => {
    const first = reduceAgentEvents(emptyThreadView(), [planProposedEvent(1, 'plan A', 'tu-1')])
    const replayed = reduceAgentEvents(first, [planProposedEvent(2, 'plan A', 'tu-1')])
    expect(replayed.items).toHaveLength(1)
    expect(replayed.lastSeq).toBe(2)
  })

  it('a second, distinct plan (different toolUseId) is a second item', () => {
    const first = reduceAgentEvents(emptyThreadView(), [planProposedEvent(1, 'plan A', 'tu-1')])
    const view = reduceAgentEvents(first, [planProposedEvent(2, 'plan B', 'tu-2')])
    expect(view.items).toHaveLength(2)
    expect(view.items[1].text).toBe('plan B')
  })
})

describe('reduceAgentEvents — pendingApprovals', () => {
  it('request.opened opens, request.resolved closes', () => {
    const opened = reduceAgentEvents(emptyThreadView(), [requestOpenedEvent(1, 'req-1')])
    expect(opened.pendingApprovals).toHaveLength(1)
    expect(opened.pendingApprovals[0].options).toContain('accept')
    const closed = reduceAgentEvents(opened, [requestResolvedEvent(2, 'req-1')])
    expect(closed.pendingApprovals).toHaveLength(0)
  })

  it('a cancel-shaped resolved event (from control_cancel_request) still closes it', () => {
    const opened = reduceAgentEvents(emptyThreadView(), [requestOpenedEvent(1, 'req-1')])
    const cancelEvent = requestResolvedEvent(2, 'req-1')
    ;(cancelEvent.payload as any).payload.decision = 'cancel'
    const closed = reduceAgentEvents(opened, [cancelEvent])
    expect(closed.pendingApprovals).toHaveLength(0)
  })

  it('acceptForSession absent from options is preserved through the fold', () => {
    const ev = requestOpenedEvent(1, 'req-1')
    ;(ev.payload as any).payload.options = ['accept', 'decline', 'cancel']
    const view = reduceAgentEvents(emptyThreadView(), [ev])
    expect(view.pendingApprovals[0].options).not.toContain('acceptForSession')
  })
})

// "Which agent and model actually ran this?" is unanswerable from the
// transcript alone: the composer's pill shows what the NEXT turn will use, and
// a thread can switch models partway through. The turn's own `turn.started`
// carries both, so they are stamped onto the same last item as the usage.
describe('reduceAgentEvents — turn engine', () => {
  function turnStarted(seq: number, provider: string, model: string): AgentEvent {
    return {
      seq,
      eventId: `ae-${seq}`,
      type: 'thread.activity-appended',
      threadId: 'w-abc',
      commandId: `ac-${seq}`,
      createdAt: 1000,
      payload: { eventId: `pe-${seq}`, type: 'turn.started', threadId: 'w-abc', provider, payload: { model } },
    }
  }
  /** An assistant message arrives as a text delta — `item.completed` with a
   *  non-tool itemType produces no item at all, so it cannot carry a stamp. */
  function assistant(seq: number, text: string): AgentEvent {
    return {
      seq,
      eventId: `ae-${seq}`,
      type: 'thread.activity-appended',
      threadId: 'w-abc',
      commandId: `ac-${seq}`,
      createdAt: 1000,
      payload: { itemId: `i-${seq}`, stream: 'text', text, sequence: seq },
    }
  }
  function settle(seq: number): AgentEvent {
    return {
      seq,
      eventId: `se-${seq}`,
      type: 'thread.session-set',
      threadId: 'w-abc',
      commandId: `sc-${seq}`,
      createdAt: 1000,
      payload: { status: 'idle', turnTokens: 900, turnOutputTokens: 400 },
    }
  }

  it('stamps the turn’s agent and model beside its usage', () => {
    const view = reduceAgentEvents(EMPTY_THREAD_VIEW, [
      turnStarted(1, 'claude', 'claude-sonnet-5'),
      assistant(2, 'done'),
      settle(3),
    ])
    const last = view.items[view.items.length - 1]
    expect(last.turnAgent).toBe('claude')
    expect(last.turnModel).toBe('claude-sonnet-5')
    // The usage it rides alongside must be untouched by this.
    expect(last.turnTokens).toBe(900)
  })

  // The reason this is read per-turn rather than from the composer: a thread
  // that switches models must keep each turn labelled with the one that ran it.
  it('does not backdate a later model onto an earlier turn', () => {
    const view = reduceAgentEvents(EMPTY_THREAD_VIEW, [
      turnStarted(1, 'claude', 'claude-opus-4-8'),
      assistant(2, 'first'),
      settle(3),
      turnStarted(4, 'claude', 'claude-sonnet-5'),
      assistant(5, 'second'),
      settle(6),
    ])
    const first = view.items.find((i) => i.text === 'first')
    const second = view.items.find((i) => i.text === 'second')
    expect(first?.turnModel).toBe('claude-opus-4-8')
    expect(second?.turnModel).toBe('claude-sonnet-5')
  })

  it('leaves both unset when the provider reported neither', () => {
    const view = reduceAgentEvents(EMPTY_THREAD_VIEW, [assistant(1, 'done'), settle(2)])
    const last = view.items[view.items.length - 1]
    expect(last.turnAgent).toBeUndefined()
    expect(last.turnModel).toBeUndefined()
  })
})

// ── waiting -> running once nothing is pending ────────────────────────────
//
// The backend recomputes this transition inside its own projector
// (`engine.go`'s EvtThreadApprovalResponseRequested / pendingRequestRemove
// cases both end in "if no pending requests and status is waiting -> running"),
// so the event it emits carries NO `status` field. This reducer only read an
// explicit `payload.status`, so a thread stayed `waiting` on the client from
// the moment an approval card was answered — which hid `••• Working for Ns`
// AND the turn stamp for the rest of the turn.
function sessionStatusEvent(seq: number, status: string): AgentEvent {
  return {
    seq, eventId: `e${seq}`, type: 'thread.session-set', threadId: 't1', commandId: `c${seq}`,
    createdAt: seq * 1000, payload: { status },
  }
}
function approvalRespondedEvent(seq: number, requestId: string, decision = 'accept'): AgentEvent {
  return {
    seq, eventId: `e${seq}`, type: 'thread.approval-response-requested', threadId: 't1', commandId: `c${seq}`,
    createdAt: seq * 1000, payload: { requestId, decision },
  }
}
function userInputRespondedEvent(seq: number, requestId: string): AgentEvent {
  return {
    seq, eventId: `e${seq}`, type: 'thread.user-input-response-requested', threadId: 't1', commandId: `c${seq}`,
    createdAt: seq * 1000, payload: { requestId, answers: { 'Q?': 'yes' } },
  }
}
function pendingRemovedEvent(seq: number, requestId: string): AgentEvent {
  return {
    seq, eventId: `e${seq}`, type: 'thread.session-set', threadId: 't1', commandId: `c${seq}`,
    createdAt: seq * 1000, payload: { pendingRequestRemove: requestId },
  }
}

describe('reduceAgentEvents — waiting settles back to running', () => {
  function waitingOnApproval(requestId = 'req-1') {
    return reduceAgentEvents(emptyThreadView(), [
      sessionStatusEvent(1, 'running'),
      requestOpenedEvent(2, requestId),
      sessionStatusEvent(3, 'waiting'),
    ])
  }

  it('the clicked path (thread.approval-response-requested) clears the card and resumes running', () => {
    const waiting = waitingOnApproval()
    expect(waiting.status).toBe('waiting')
    expect(waiting.pendingApprovals).toHaveLength(1)

    const answered = reduceAgentEvents(waiting, [approvalRespondedEvent(4, 'req-1')])
    expect(answered.pendingApprovals).toHaveLength(0)
    expect(answered.status).toBe('running')
  })

  it('a declined approval resumes running too — the turn continues either way', () => {
    const answered = reduceAgentEvents(waitingOnApproval(), [approvalRespondedEvent(4, 'req-1', 'decline')])
    expect(answered.status).toBe('running')
  })

  it('the timeout path (session-set pendingRequestRemove) resumes running', () => {
    const answered = reduceAgentEvents(waitingOnApproval(), [pendingRemovedEvent(4, 'req-1')])
    expect(answered.pendingApprovals).toHaveLength(0)
    expect(answered.status).toBe('running')
  })

  it('the forwarded request.resolved path resumes running', () => {
    const answered = reduceAgentEvents(waitingOnApproval(), [requestResolvedEvent(4, 'req-1')])
    expect(answered.status).toBe('running')
  })

  it('a user-input answer resumes running', () => {
    const waiting = reduceAgentEvents(emptyThreadView(), [
      sessionStatusEvent(1, 'running'),
      userInputRequestedEvent(2, 'req-1'),
      sessionStatusEvent(3, 'waiting'),
    ])
    expect(waiting.status).toBe('waiting')
    const answered = reduceAgentEvents(waiting, [userInputRespondedEvent(4, 'req-1')])
    expect(answered.pendingUserInputs).toHaveLength(0)
    expect(answered.status).toBe('running')
  })

  // The backend keeps ONE PendingRequests map; this view splits it in two, so
  // "empty" has to mean both halves or a thread with an open question and an
  // open approval would resume as soon as either one was answered.
  it('stays waiting while a SECOND request is still open', () => {
    const waiting = reduceAgentEvents(emptyThreadView(), [
      sessionStatusEvent(1, 'running'),
      requestOpenedEvent(2, 'req-1'),
      userInputRequestedEvent(3, 'req-2'),
      sessionStatusEvent(4, 'waiting'),
    ])
    const half = reduceAgentEvents(waiting, [approvalRespondedEvent(5, 'req-1')])
    expect(half.status).toBe('waiting')
    const done = reduceAgentEvents(half, [userInputRespondedEvent(6, 'req-2')])
    expect(done.status).toBe('running')
  })

  // Both the RequestResolved path (forwarded event + session-set) and a
  // reconnect tail re-deliver the same resolution. Neither may promote a
  // settled thread back to running.
  it('never promotes an idle or stopped thread', () => {
    for (const status of ['idle', 'stopped'] as const) {
      const settled = reduceAgentEvents(emptyThreadView(), [sessionStatusEvent(1, status)])
      const after = reduceAgentEvents(settled, [approvalRespondedEvent(2, 'req-1')])
      expect(after.status).toBe(status)
    }
  })

  it('an explicit status on the same session-set still wins over the derived one', () => {
    const waiting = waitingOnApproval()
    const stopped = reduceAgentEvents(waiting, [{
      seq: 4, eventId: 'e4', type: 'thread.session-set', threadId: 't1', commandId: 'c4',
      createdAt: 4000, payload: { status: 'stopped', pendingRequestRemove: 'req-1' },
    }])
    expect(stopped.status).toBe('stopped')
  })
})

// ── the turn engine survives the socket's batching ───────────────────────────
//
// Every test in "turn engine" above folds a whole turn in ONE reduceAgentEvents
// call, which is what a reconnect replay does — and it is the ONLY shape that
// worked. A live turn arrives as many small batches (the reducer is called once
// per socket frame), so `turn.started` and the session-set that closes the turn
// are separate calls seconds apart. Held as reducer locals, agent/model were
// `undefined` by the time the stamp was written and the engine half of the
// stamp went missing on every live turn while the replayed one was correct.
describe('reduceAgentEvents — turn engine across batches', () => {
  function turnStartedEv(seq: number, provider: string, model: string): AgentEvent {
    return {
      seq, eventId: `ae-${seq}`, type: 'thread.activity-appended', threadId: 'w-abc', commandId: `ac-${seq}`,
      createdAt: 1000,
      payload: { eventId: `pe-${seq}`, type: 'turn.started', threadId: 'w-abc', provider, payload: { model } },
    }
  }
  function deltaEv(seq: number, text: string): AgentEvent {
    return {
      seq, eventId: `ae-${seq}`, type: 'thread.activity-appended', threadId: 'w-abc', commandId: `ac-${seq}`,
      createdAt: 1000, payload: { itemId: `i-${seq}`, stream: 'text', text, sequence: seq },
    }
  }
  function settleEv(seq: number): AgentEvent {
    return {
      seq, eventId: `se-${seq}`, type: 'thread.session-set', threadId: 'w-abc', commandId: `sc-${seq}`,
      createdAt: 1000, payload: { status: 'idle', turnTokens: 900, turnOutputTokens: 400 },
    }
  }

  /** One reduceAgentEvents call per event — the worst case of what the socket
   *  does, and the shape that reproduced the bug. */
  function foldOneAtATime(events: AgentEvent[]) {
    return events.reduce((view, event) => reduceAgentEvents(view, [event]), EMPTY_THREAD_VIEW)
  }

  it('stamps agent and model when each event arrives in its own batch', () => {
    const view = foldOneAtATime([
      turnStartedEv(1, 'claude', 'claude-opus-5'),
      deltaEv(2, 'done'),
      settleEv(3),
    ])
    const last = view.items[view.items.length - 1]
    expect(last.turnAgent).toBe('claude')
    expect(last.turnModel).toBe('claude-opus-5')
  })

  it('matches what a single-batch replay of the same log produces', () => {
    const events = [turnStartedEv(1, 'claude', 'claude-opus-5'), deltaEv(2, 'done'), settleEv(3)]
    const streamed = foldOneAtATime(events)
    const replayed = reduceAgentEvents(EMPTY_THREAD_VIEW, events)
    const lastOf = (v: typeof streamed) => v.items[v.items.length - 1]
    expect(lastOf(streamed).turnAgent).toBe(lastOf(replayed).turnAgent)
    expect(lastOf(streamed).turnModel).toBe(lastOf(replayed).turnModel)
  })

  // The carry is per-TURN, not per-thread: it is cleared when a turn settles so
  // the next one cannot inherit the model that ran the previous one. Batching
  // must not turn that into a leak.
  it('does not carry one turn’s engine into the next', () => {
    const view = foldOneAtATime([
      turnStartedEv(1, 'claude', 'claude-opus-5'),
      deltaEv(2, 'first'),
      settleEv(3),
      deltaEv(4, 'second'),
      settleEv(5),
    ])
    const second = view.items[view.items.length - 1]
    expect(second.text).toBe('second')
    expect(second.turnAgent).toBeUndefined()
    expect(second.turnModel).toBeUndefined()
    expect(view.turnAgent).toBeUndefined()
  })

  it('holds the engine on the view until the turn settles', () => {
    const midTurn = foldOneAtATime([turnStartedEv(1, 'claude', 'claude-opus-5'), deltaEv(2, 'partial')])
    expect(midTurn.turnAgent).toBe('claude')
    expect(midTurn.turnModel).toBe('claude-opus-5')
  })
})

// ── the two events that were reduced to nothing ──────────────────────────────
//
// Both reached applyForwarded and fell straight through its
// `itemType !== 'tool_call'` guard, and both are the moment a turn goes quiet
// for no visible reason. `parse.go` emits `tool.denied` for the express purpose
// of making an auto-denial "visible in the transcript instead of invisible";
// the backend kept its half of that, this side never did.
describe('reduceAgentEvents — DevDeck’s own refusals are visible', () => {
  function forwarded(seq: number, type: string, payload: Record<string, unknown>): AgentEvent {
    return {
      seq, eventId: `e${seq}`, type: 'thread.activity-appended', threadId: 't1', commandId: `c${seq}`,
      createdAt: seq * 1000, payload: { type, threadId: 't1', payload },
    }
  }

  it('surfaces an auto-denied tool call, naming the tool and the reason', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      forwarded(1, 'tool.denied', {
        toolName: 'ExitPlanMode',
        message: 'Plan captured by DevDeck. Continue without it.',
      }),
    ])
    expect(view.items).toHaveLength(1)
    expect(view.items[0].kind).toBe('notice')
    expect(view.items[0].text).toContain('ExitPlanMode')
    expect(view.items[0].text).toContain('Plan captured by DevDeck')
  })

  // The one the operator most needs: the CLI blocks until something replies, so
  // the parser auto-denies an unimplemented control_request subtype with a
  // sentence the AGENT hears and the operator did not.
  it('surfaces a control request DevDeck does not implement', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      forwarded(1, 'runtime.warning', {
        message: 'unrecognized control_request subtype "request_user_dialog"',
      }),
    ])
    expect(view.items).toHaveLength(1)
    expect(view.items[0].kind).toBe('notice')
    expect(view.items[0].text).toContain('request_user_dialog')
  })

  // A notice is not a failure. `applyForwarded`'s error branch settles a
  // running thread to idle; declining one tool must not end the turn.
  it('does not settle the thread the way an error does', () => {
    const running = reduceAgentEvents(emptyThreadView(), [
      { seq: 1, eventId: 'e1', type: 'thread.turn-start-requested', threadId: 't1', commandId: 'c1', createdAt: 1000 },
    ])
    expect(running.status).toBe('running')
    const after = reduceAgentEvents(running, [
      forwarded(2, 'tool.denied', { toolName: 'ExitPlanMode', message: 'nope' }),
    ])
    expect(after.status).toBe('running')
    expect(after.items[after.items.length - 1].kind).toBe('notice')
  })

  it('falls back to a readable sentence when the payload carries no message', () => {
    const view = reduceAgentEvents(emptyThreadView(), [forwarded(1, 'tool.denied', {})])
    expect(view.items[0].text).toMatch(/A tool was not allowed to run/)
  })
})

/**
 * The replay path merges each consecutive run of same-item deltas into one
 * event (`orchestration.CoalesceReplay`, backend `replay.go`) because a
 * streamed turn is durably logged one event per token — a ~27x JSON envelope
 * tax that had one real thread replaying 274,851 events / ~70 MB in a single
 * frame on every page load.
 *
 * The contract these tests pin is equivalence: a merged run must fold to
 * exactly the view the per-token run it replaces would have produced. If that
 * ever stops holding, replayed threads and live ones disagree about their own
 * history.
 */
describe('reduceAgentEvents / coalesced replay deltas', () => {
  /** One merged run: `sequence`/`createdAt` are the run's LAST, and
   *  `firstSequence`/`startedAt` its first — see `ActivityAppendedPayload`. */
  function merged(
    seq: number,
    itemId: string,
    text: string,
    firstSequence: number,
    lastSequence: number,
    { stream = 'text', startedAt = 1000, createdAt = 1000 } = {},
  ): AgentEvent {
    return {
      seq,
      eventId: `ae-${seq}`,
      type: 'thread.activity-appended',
      threadId: 'w-abc',
      commandId: `ac-${seq}`,
      createdAt,
      payload: { itemId, stream, text, sequence: lastSequence, firstSequence, startedAt },
    }
  }

  it('folds a merged run into the same item the per-token run produces', () => {
    const perToken = reduceAgentEvents(emptyThreadView(), [
      delta(1, 'i1', 'Hel', 1),
      delta(2, 'i1', 'lo ', 2),
      delta(3, 'i1', 'world', 3),
    ])
    const coalesced = reduceAgentEvents(emptyThreadView(), [merged(3, 'i1', 'Hello world', 1, 3)])

    expect(coalesced.items).toHaveLength(1)
    expect(coalesced.items[0].text).toBe(perToken.items[0].text)
    expect(coalesced.items[0].kind).toBe(perToken.items[0].kind)
    expect(coalesced.items[0].lastSequence).toBe(perToken.items[0].lastSequence)
    // The cursor has to land on the run's last Seq, or the next reconnect asks
    // for events it already applied and concatenates the tail a second time.
    expect(coalesced.lastSeq).toBe(3)
    expect(coalesced.hasGap).toBe(false)
  })

  it('does not flag a gap when a contiguous run resumes after a tool call', () => {
    // 36 of 902 items in the field thread resume like this. The run carries
    // firstSequence 3 against the item's lastSequence 2 — contiguous.
    const view = reduceAgentEvents(emptyThreadView(), [
      merged(1, 'i1', 'before', 1, 2),
      merged(2, 'i1', ' after', 3, 4),
    ])
    expect(view.items).toHaveLength(1)
    expect(view.items[0].text).toBe('before after')
    expect(view.hasGap).toBe(false)
  })

  it('still flags a real hole between two merged runs', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      merged(1, 'i1', 'ab', 1, 2),
      merged(2, 'i1', 'cd', 7, 8),
    ])
    expect(view.hasGap).toBe(true)
  })

  it('stamps a merged item with when the agent started writing it, not finished', () => {
    // Without `startedAt` the item would take the merged event's own createdAt
    // — the run's END — and every replayed turn would report a zero duration.
    const view = reduceAgentEvents(emptyThreadView(), [
      merged(1, 'i1', 'a long reply', 1, 400, { startedAt: 5_000, createdAt: 17_000 }),
    ])
    expect(view.items[0].createdAt).toBe(5_000)
    expect(view.items[0].updatedAt).toBe(17_000)
  })

  it('leaves a live delta (no merge fields) behaving exactly as before', () => {
    const view = reduceAgentEvents(emptyThreadView(), [delta(1, 'i1', 'x', 1), delta(2, 'i1', 'y', 2)])
    expect(view.items[0].text).toBe('xy')
    expect(view.items[0].createdAt).toBe(1000)
    expect(view.hasGap).toBe(false)
  })

  it('applies a merged run on top of an item a live delta already opened', () => {
    // The replay/live boundary: a reconnect replays the run, the socket then
    // delivers its own tail. Both must land on one item.
    const live = reduceAgentEvents(emptyThreadView(), [delta(1, 'i1', 'start', 1)])
    const after = reduceAgentEvents(live, [merged(2, 'i1', ' and more', 2, 9)])
    expect(after.items).toHaveLength(1)
    expect(after.items[0].text).toBe('start and more')
    expect(after.items[0].lastSequence).toBe(9)
    expect(after.hasGap).toBe(false)
  })
})

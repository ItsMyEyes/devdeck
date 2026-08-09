import { describe, expect, it } from 'vitest'
import {
  entryCompletedAt,
  entryCreatedAt,
  messageRole,
  promptChatStatus,
  toolUIState,
  toolUIType,
  turnSpans,
  withHardBreaks,
} from '@/features/agent-chat/adapter'
import { buildTimeline } from '@/features/agent-chat/timeline'
import { emptyThreadView } from '@/features/agent-chat/eventReducer'
import type { ChatItem } from '@/features/agent-chat/types'

function item(partial: Partial<ChatItem> & Pick<ChatItem, 'id' | 'kind'>): ChatItem {
  return { text: '', lastSequence: 0, ...partial }
}

describe('messageRole', () => {
  it('maps a user item to the user role', () => {
    expect(messageRole('user')).toBe('user')
  })

  it('maps everything else to assistant', () => {
    expect(messageRole('assistant')).toBe('assistant')
    expect(messageRole('reasoning')).toBe('assistant')
    expect(messageRole('tool')).toBe('assistant')
    expect(messageRole('error')).toBe('assistant')
  })
})

describe('toolUIType', () => {
  it('namespaces the tool name the way ToolHeader parses it back out', () => {
    expect(toolUIType('Edit')).toBe('tool-Edit')
  })

  it('falls back to a generic name when the provider sent none', () => {
    expect(toolUIType(undefined)).toBe('tool-Tool')
  })

  it('keeps a hyphenated tool name intact', () => {
    // ToolHeader derives the label with type.split('-').slice(1).join('-'),
    // so a hyphen inside the name survives the round trip.
    expect(toolUIType('web-search')).toBe('tool-web-search')
  })
})

describe('toolUIState', () => {
  // The badge labels these map to are "Pending" / "Running" / "Completed" /
  // "Error". This app never has a tool RESULT (the Claude provider does not
  // parse tool_result), so 'output-available' means "the call finished", and
  // no ToolOutput is ever rendered.
  it('maps a running tool to the Running badge state', () => {
    expect(toolUIState('running')).toBe('input-available')
  })

  it('maps a finished tool to the Completed badge state', () => {
    expect(toolUIState('done')).toBe('output-available')
  })

  it('maps a failed tool to the Error badge state', () => {
    expect(toolUIState('failed')).toBe('output-error')
  })

  it('maps an unknown status to the Pending badge state', () => {
    expect(toolUIState(undefined)).toBe('input-streaming')
  })
})

describe('promptChatStatus', () => {
  it('reports ready when the thread is idle', () => {
    expect(promptChatStatus({ ...emptyThreadView(), status: 'idle' })).toBe('ready')
  })

  it('reports streaming while a turn is in flight', () => {
    expect(promptChatStatus({ ...emptyThreadView(), status: 'running' })).toBe('streaming')
  })

  it('reports submitted while the agent waits on the user', () => {
    expect(promptChatStatus({ ...emptyThreadView(), status: 'waiting' })).toBe('submitted')
  })

  it('reports ready when the thread has stopped', () => {
    expect(promptChatStatus({ ...emptyThreadView(), status: 'stopped' })).toBe('ready')
  })

  it('reports error when the thread carries one, whatever its status', () => {
    expect(promptChatStatus({ ...emptyThreadView(), status: 'running', error: 'boom' })).toBe('error')
  })
})

describe('entryCreatedAt', () => {
  it('reads the stamp off a message entry', () => {
    const entries = buildTimeline({ ...emptyThreadView(), items: [item({ id: 'm1', kind: 'user', createdAt: 500 })] })
    expect(entryCreatedAt(entries[0])).toBe(500)
  })

  it('reads the first item stamp off a tool group', () => {
    const entries = buildTimeline({
      ...emptyThreadView(),
      items: [item({ id: 't1', kind: 'tool', createdAt: 700 }), item({ id: 't2', kind: 'tool', createdAt: 900 })],
    })
    expect(entries).toHaveLength(1)
    expect(entryCreatedAt(entries[0])).toBe(700)
  })

  it('returns undefined for an unstamped entry', () => {
    const entries = buildTimeline({ ...emptyThreadView(), items: [item({ id: 'm1', kind: 'user' })] })
    expect(entryCreatedAt(entries[0])).toBeUndefined()
  })
})

describe('turnSpans', () => {
  it('gives each turn a first and last entry index', () => {
    const entries = buildTimeline({
      ...emptyThreadView(),
      items: [
        item({ id: 'u1', kind: 'user', createdAt: 100 }),
        item({ id: 'a1', kind: 'assistant', createdAt: 200 }),
        item({ id: 'u2', kind: 'user', createdAt: 300 }),
        item({ id: 'a2', kind: 'assistant', createdAt: 400 }),
      ],
    })
    expect(turnSpans(entries)).toEqual([
      { key: 'u1', firstEntryIndex: 0, lastEntryIndex: 1 },
      { key: 'u2', firstEntryIndex: 2, lastEntryIndex: 3 },
    ])
  })

  it('covers a thread replayed with no leading user message', () => {
    const entries = buildTimeline({
      ...emptyThreadView(),
      items: [item({ id: 'a1', kind: 'assistant', createdAt: 100 }), item({ id: 'a2', kind: 'assistant', createdAt: 200 })],
    })
    expect(turnSpans(entries)).toEqual([{ key: 'a1', firstEntryIndex: 0, lastEntryIndex: 1 }])
  })

  it('returns nothing for an empty timeline', () => {
    expect(turnSpans([])).toEqual([])
  })
})

// Regression: the turn footer stamped `entryCreatedAt` of the turn's LAST
// entry, which for a streamed assistant message is its time-to-first-token —
// so a 47-second turn read `• 3s`, and a trailing tool group was stamped with
// its earliest call. The end of a turn is the newest fold into its last entry.
describe('entryCompletedAt', () => {
  it('prefers the last fold over the item creation stamp', () => {
    const entries = buildTimeline({
      ...emptyThreadView(),
      items: [item({ id: 'a1', kind: 'assistant', createdAt: 3_000, updatedAt: 47_000 })],
    })
    expect(entryCompletedAt(entries[0])).toBe(47_000)
  })

  it('falls back to createdAt for an item nothing was folded into', () => {
    const entries = buildTimeline({ ...emptyThreadView(), items: [item({ id: 'a1', kind: 'assistant', createdAt: 3_000 })] })
    expect(entryCompletedAt(entries[0])).toBe(3_000)
  })

  it('takes the latest fold across a whole tool group, not its first call', () => {
    const entries = buildTimeline({
      ...emptyThreadView(),
      items: [
        item({ id: 't1', kind: 'tool', createdAt: 5_000, updatedAt: 9_000 }),
        item({ id: 't2', kind: 'tool', createdAt: 10_000, updatedAt: 40_000 }),
      ],
    })
    expect(entries).toHaveLength(1)
    expect(entryCompletedAt(entries[0])).toBe(40_000)
  })

  it('reads a reasoning entry', () => {
    const entries = buildTimeline({
      ...emptyThreadView(),
      items: [item({ id: 'r1', kind: 'reasoning', createdAt: 1_000, updatedAt: 2_000 })],
    })
    expect(entryCompletedAt(entries[0])).toBe(2_000)
  })

  it('returns undefined for an unstamped entry', () => {
    const entries = buildTimeline({ ...emptyThreadView(), items: [item({ id: 'm1', kind: 'user' })] })
    expect(entryCompletedAt(entries[0])).toBeUndefined()
  })

  it('returns undefined for a tool group with no stamps at all', () => {
    const entries = buildTimeline({
      ...emptyThreadView(),
      items: [item({ id: 't1', kind: 'tool' }), item({ id: 't2', kind: 'tool' })],
    })
    expect(entryCompletedAt(entries[0])).toBeUndefined()
  })
})

// Regression: the hand-rolled bubble used `whitespace-pre-wrap`, so agent
// narration ("Done.\nNext I will run the tests.") kept its line breaks.
// CommonMark treats a single newline as a space, and Streamdown ships neither
// remark-breaks nor a way to append a plugin without replacing its own default
// list — so the text is prepared here instead, which also keeps this testable
// without a DOM.
describe('withHardBreaks', () => {
  it('turns a single newline into a markdown hard break', () => {
    expect(withHardBreaks('Done.\nNext I will run the tests.')).toBe('Done.  \nNext I will run the tests.')
  })

  it('leaves a paragraph break alone', () => {
    expect(withHardBreaks('one\n\ntwo')).toBe('one\n\ntwo')
  })

  it('leaves text with no newline alone', () => {
    expect(withHardBreaks('just one line')).toBe('just one line')
  })

  it('does not touch the inside of a fenced code block', () => {
    const fenced = 'run this:\n```go\nfunc main() {\n\tprintln("hi")\n}\n```\ndone'
    expect(withHardBreaks(fenced)).toBe('run this:  \n```go\nfunc main() {\n\tprintln("hi")\n}\n```\ndone')
  })

  it('leaves an unterminated fence open to the end of the text', () => {
    expect(withHardBreaks('```go\nfunc main() {\nreturn')).toBe('```go\nfunc main() {\nreturn')
  })

  it('does not double a break the author already wrote', () => {
    expect(withHardBreaks('a  \nb')).toBe('a  \nb')
    expect(withHardBreaks('a\\\nb')).toBe('a\\\nb')
  })

  it('is a no-op on empty text', () => {
    expect(withHardBreaks('')).toBe('')
  })
})

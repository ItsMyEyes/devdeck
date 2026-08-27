import { describe, expect, it } from 'vitest'
import {
  entryCompletedAt,
  entryCreatedAt,
  lastTurnModel,
  messageRole,
  promptChatStatus,
  toolUIState,
  toolDisplayName,
  toolResultText,
  toolSummary,
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

describe('toolDisplayName', () => {
  it('shows the tool name the provider sent, as-is', () => {
    expect(toolDisplayName('Edit')).toBe('Edit')
  })

  it('falls back to a generic name when the provider sent none', () => {
    expect(toolDisplayName(undefined)).toBe('Tool')
  })

  // Regression against the former `toolUIType`, which encoded the name as
  // `tool-<name>` for upstream ToolHeader to split back apart on '-'. A
  // hyphenated name was the one input that round-trip could mangle.
  it('keeps a hyphenated tool name intact', () => {
    expect(toolDisplayName('web-search')).toBe('web-search')
  })
})

describe('toolResultText', () => {
  it('unwraps the content-part envelope providers report results in', () => {
    expect(toolResultText({ content: [{ type: 'text', text: 'new-superapps-dev2' }] })).toBe('new-superapps-dev2')
  })

  it('joins multiple text parts in order', () => {
    expect(toolResultText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
  })

  it('passes a bare string through', () => {
    expect(toolResultText('ok')).toBe('ok')
  })

  it('declines shapes it does not recognise, so the caller can fall back to JSON', () => {
    expect(toolResultText({ content: [{ type: 'image', data: '…' }] })).toBeUndefined()
    expect(toolResultText({ exitCode: 0 })).toBeUndefined()
    expect(toolResultText(undefined)).toBeUndefined()
    expect(toolResultText(null)).toBeUndefined()
  })

  it('treats an empty result as nothing to show', () => {
    expect(toolResultText({ content: [] })).toBeUndefined()
    expect(toolResultText('')).toBeUndefined()
  })
})

describe('toolSummary', () => {
  it('names the file a read or edit is about', () => {
    expect(toolSummary({ file_path: '/a/b.go', offset: 40 })).toBe('/a/b.go')
  })

  it('prefers the more specific key when a call carries several', () => {
    // file_path outranks command: a tool that names a file is about that file.
    expect(toolSummary({ command: 'go test ./...', file_path: '/a/b.go' })).toBe('/a/b.go')
  })

  it('shows the command a shell call runs', () => {
    expect(toolSummary({ command: 'go test ./...' })).toBe('go test ./...')
  })

  it('flattens a multi-line command onto one line', () => {
    expect(toolSummary({ command: 'set -e\n\n  go build ./...' })).toBe('set -e go build ./...')
  })

  it('caps a runaway argument so a heredoc cannot reach the DOM', () => {
    const summary = toolSummary({ command: 'x'.repeat(500) })
    expect(summary).toHaveLength(161)
    expect(summary?.endsWith('…')).toBe(true)
  })

  // A row with nothing to say must render no summary span at all, rather than an
  // empty one that still takes its place in the flex layout.
  it('has nothing to say about a call with no recognised argument', () => {
    expect(toolSummary({ todos: [] })).toBeUndefined()
    expect(toolSummary({ file_path: '   ' })).toBeUndefined()
  })

  it('has nothing to say about an input that is not an object', () => {
    expect(toolSummary(undefined)).toBeUndefined()
    expect(toolSummary('go test')).toBeUndefined()
    expect(toolSummary(['go test'])).toBeUndefined()
    expect(toolSummary(null)).toBeUndefined()
  })

  // ── Paths are shortened from the LEFT ──
  // The row truncates with CSS, which cuts the END — and for a path the end is
  // the only identifying part. Six reads under one deep tree used to render as
  // six rows of the same 70-character prefix with every filename cut off.
  describe('long file paths', () => {
    it('keeps the tail of a deep POSIX path, whole segments only', () => {
      expect(toolSummary({ file_path: '/Users/andsy/code/superapps/internal/api/v1/usecase/kyc/usecase.go' })).toBe(
        '…/internal/api/v1/usecase/kyc/usecase.go',
      )
    })

    it('keeps a Windows path a Windows path', () => {
      expect(
        toolSummary({ file_path: 'C:\\Users\\andsy\\Documents\\code\\superapps\\internal\\usecase\\usecase.go' }),
      ).toBe('…\\code\\superapps\\internal\\usecase\\usecase.go')
    })

    it('leaves a path that already fits exactly as it arrived', () => {
      expect(toolSummary({ file_path: '/a/b.go' })).toBe('/a/b.go')
      expect(toolSummary({ path: 'internal/api/v1/usecase/kyc/usecase.go' })).toBe('internal/api/v1/usecase/kyc/usecase.go')
    })

    it('still shows the filename when it is the only segment that fits', () => {
      const summary = toolSummary({ file_path: `/a/b/${'name'.repeat(20)}.go` })
      expect(summary).toBe(`…/${'name'.repeat(20)}.go`)
    })

    // A command's information is at the front: `git -C /very/long/path status`
    // cut from the left would misreport what ran.
    it('never shortens a command, however many slashes it has', () => {
      const command = 'go test ./internal/api/v1/usecase/kyc/... -run TestSubmitSemiAutomate -count 1'
      expect(toolSummary({ command })).toBe(command)
    })
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

// The composer's model pill is local state, so every tab/pane/SSH-session
// switch remounts it back to `null` and the pill reads "Model" on a thread
// that has been running Sonnet for twenty turns — with the next message then
// silently going to the worktree's DEFAULT model. This is what it restores from.
describe('lastTurnModel', () => {
  const stamped = (id: string, turnAgent?: string, turnModel?: string): ChatItem => ({
    id,
    kind: 'assistant',
    text: id,
    createdAt: 1,
    updatedAt: 1,
    lastSequence: 0,
    ...(turnAgent ? { turnAgent } : {}),
    ...(turnModel ? { turnModel } : {}),
  })

  it('reads the agent and model off the most recent settled turn', () => {
    expect(lastTurnModel([stamped('a', 'claude', 'claude-opus-5')])).toEqual({
      agentId: 'claude',
      modelId: 'claude-opus-5',
    })
  })

  // A thread whose model was switched partway through resumes on the model it
  // is on NOW, not the one it started on.
  it('takes the newest stamp, not the oldest', () => {
    const items = [
      stamped('a', 'claude', 'claude-opus-5'),
      stamped('b'),
      stamped('c', 'claude', 'claude-sonnet-5'),
      stamped('d'),
    ]
    expect(lastTurnModel(items)?.modelId).toBe('claude-sonnet-5')
  })

  it('has no answer for a thread that never completed a turn', () => {
    expect(lastTurnModel([])).toBeUndefined()
    expect(lastTurnModel([stamped('a'), stamped('b')])).toBeUndefined()
  })

  // Both halves or nothing: `instanceIdForAgent(agentId)` and the model id are
  // sent together, so half a stamp would resume onto a guess.
  it('ignores a half-stamped item', () => {
    expect(lastTurnModel([stamped('a', 'claude', undefined)])).toBeUndefined()
    expect(lastTurnModel([stamped('a', undefined, 'claude-opus-5')])).toBeUndefined()
  })
})

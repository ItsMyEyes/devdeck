import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { MessagesTimeline } from '@/features/agent-chat/MessagesTimeline'
import { emptyThreadView } from '@/features/agent-chat/eventReducer'
import { buildTerminalContextBlock } from '@/features/agent-chat/terminalContext'
import type { AgentThreadView, ChatItem } from '@/features/agent-chat/types'
import type { Machine } from '@/store/types'

// Shiki compiles a real grammar and (depending on the engine) reaches for
// WASM, which is slow-to-impossible under jsdom. ToolInput renders a
// CodeBlock, so stub the vendored module: these tests are about which rows
// appear and what they say, not about highlighting.
vi.mock('@/components/ai-elements/code-block', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
  CodeBlockCopyButton: () => null,
}))

// T11 (composer-context-attachments, C2): only `fetchAgentAttachmentBlob` is
// stubbed — this file mounts `MessagesTimeline` directly, never through a
// real machine.
const fetchAgentAttachmentBlobMock = vi.fn()
vi.mock('@/lib/machineApi', () => ({
  fetchAgentAttachmentBlob: (...args: unknown[]) => fetchAgentAttachmentBlobMock(...args),
}))

afterEach(() => {
  cleanup()
})

function item(partial: Partial<ChatItem> & Pick<ChatItem, 'id' | 'kind'>): ChatItem {
  return { text: '', lastSequence: 0, ...partial }
}

function view(items: ChatItem[], overrides: Partial<AgentThreadView> = {}): AgentThreadView {
  return { ...emptyThreadView(), items, ...overrides }
}

describe('MessagesTimeline', () => {
  it('renders assistant markdown as markup, not as literal text', () => {
    render(<MessagesTimeline view={view([item({ id: 'a1', kind: 'assistant', text: '## Heading\n\nsome **bold** text' })])} />)

    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument()
    // The vendored Streamdown renders bold as a `<span data-streamdown="strong">`
    // (styled with font-semibold), not a literal `<strong>` tag — asserting on
    // that marker still proves markdown became markup, not a literal `**bold**`.
    expect(screen.getByText('bold')).toHaveAttribute('data-streamdown', 'strong')
  })

  it('marks a user turn as the user role', () => {
    const { container } = render(<MessagesTimeline view={view([item({ id: 'u1', kind: 'user', text: 'hello' })])} />)

    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(container.querySelector('.is-user')).not.toBeNull()
  })

  it('renders an error item as an error, not as a message bubble', () => {
    render(<MessagesTimeline view={view([item({ id: 'e1', kind: 'error', text: 'claude exited 1' })])} />)

    expect(screen.getByRole('alert')).toHaveTextContent('claude exited 1')
  })

  it('keeps reasoning collapsed until it is opened', async () => {
    render(<MessagesTimeline view={view([item({ id: 'r1', kind: 'reasoning', text: 'thinking about the limiter' })])} />)

    expect(screen.queryByText(/thinking about the limiter/)).not.toBeInTheDocument()
    // The trigger reads "Worked for Ns" (t3code's wording), falling back to
    // "a few seconds" for a block with no timestamps — the vendored default,
    // a brain glyph plus "Thought for…", is replaced outright by
    // `ReasoningLabel`. Nothing in it contains the word "reasoning".
    await userEvent.click(screen.getByRole('button', { name: /worked for a few seconds/i }))
    expect(screen.getByText(/thinking about the limiter/)).toBeInTheDocument()
  })

  // The vendored `Reasoning` can only time a stream it watched itself, so a
  // thread replayed after a reconnect showed "a few seconds" on every block.
  // The duration comes from the orchestration event's own stamps instead.
  it('labels a replayed reasoning block with the duration it actually took', () => {
    render(
      <MessagesTimeline
        view={view([item({ id: 'r1', kind: 'reasoning', text: 'weighing the options', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_011_000 })])}
      />,
    )

    expect(screen.getByRole('button', { name: /worked for 11s/i })).toBeInTheDocument()
  })

  // The compact row spends its width on the call, not on chrome: the status is a
  // glyph rather than upstream's pill badge, so its wording survives only as the
  // trigger's `sr-only` accessible name. A button announcing just "Edit" would
  // not say whether it had finished.
  it('shows a tool call with its name and a screen-reader-readable status', () => {
    render(<MessagesTimeline view={view([item({ id: 't1', kind: 'tool', toolName: 'Edit', status: 'running' })])} />)

    expect(screen.getByText('Edit')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /edit.*running/i })).toBeInTheDocument()
  })

  // Without this, a turn that reads ten files is ten identical `Read` rows and
  // the only way to learn what it read is to expand each one.
  it('shows the call\'s primary argument on the collapsed row', () => {
    render(
      <MessagesTimeline
        view={view([
          item({ id: 't1', kind: 'tool', toolName: 'Bash', status: 'done', input: { command: 'go test ./...' } }),
        ])}
      />,
    )

    expect(screen.getByText('go test ./...')).toBeInTheDocument()
  })

  it('reveals the tool arguments when the row is expanded', async () => {
    render(
      <MessagesTimeline
        view={view([item({ id: 't1', kind: 'tool', toolName: 'Edit', status: 'done', input: { file_path: '/a/b.go' } })])}
      />,
    )

    // `Edit:` — the name carries a trailing colon whenever a summary follows
    // it, so the row reads `Edit: /a/b.go` rather than two unrelated words.
    await userEvent.click(screen.getByText('Edit:'))
    expect(screen.getByTestId('code-block')).toHaveTextContent('"file_path": "/a/b.go"')
  })

  // Regression: a tool row used to show `bash bash` and expand to a result
  // envelope. `item.completed`'s detail is the ARGUMENTS for claude but a
  // `{toolCallId,name,result}` wrapper for pi, and the reducer read the second
  // as if it were the first — see `eventReducer.ts`'s `toolDetailParts`. This
  // asserts the rendering half: a row with both halves names the command and
  // discloses the output as text, not as JSON punctuation.
  it('names the command in the row and shows the result as text', async () => {
    render(
      <MessagesTimeline
        view={view([
          item({
            id: 't1',
            kind: 'tool',
            toolName: 'bash',
            status: 'done',
            input: { command: 'ssh dev2 uname -a' },
            output: { content: [{ type: 'text', text: 'Linux dev2 6.12.43' }] },
          }),
        ])}
      />,
    )

    expect(screen.getByText('ssh dev2 uname -a')).toBeInTheDocument()

    await userEvent.click(screen.getByText('bash:'))
    expect(screen.getByText('Linux dev2 6.12.43')).toBeInTheDocument()
    // The result reads as output, not as a stringified envelope.
    expect(screen.queryByText(/"content"/)).not.toBeInTheDocument()
  })

  it('folds all but the newest call of a run behind a disclosure', async () => {
    render(
      <MessagesTimeline
        view={view([
          item({ id: 't1', kind: 'tool', toolName: 'Read', status: 'done' }),
          item({ id: 't2', kind: 'tool', toolName: 'Grep', status: 'done' }),
          item({ id: 't3', kind: 'tool', toolName: 'Edit', status: 'done' }),
        ])}
      />,
    )

    // collapseWorkLog keeps the newest 1 visible; the other 2 fold.
    expect(screen.getByText('Edit')).toBeInTheDocument()
    expect(screen.queryByText('Read')).not.toBeInTheDocument()

    // The vendored TaskTrigger renders `asChild` onto a plain `<div>` with no
    // `role="button"`, so it isn't reachable via `getByRole('button', ...)`;
    // click the label text it renders instead.
    await userEvent.click(screen.getByText(/2 earlier steps/i))
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByText('Grep')).toBeInTheDocument()
  })

  it('stamps a completed turn from the event timestamps, not from a render-time clock', () => {
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'go', createdAt: 1_700_000_000_000 }),
            item({ id: 'a1', kind: 'assistant', text: 'done', createdAt: 1_700_000_010_000 }),
          ],
          { status: 'idle' },
        )}
      />,
    )

    expect(screen.getByText(/10s$/)).toBeInTheDocument()
  })

  it('does not stamp the trailing turn while it is still running', () => {
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'go', createdAt: 1_700_000_000_000 }),
            item({ id: 'a1', kind: 'assistant', text: 'partial', createdAt: 1_700_000_003_000 }),
          ],
          { status: 'running' },
        )}
      />,
    )

    // The turn stamp, specifically — matched by its `HH:MM:SS •` prefix rather
    // than by a bare trailing "…s", because the working row legitimately ends
    // in one now ("Working for 12s") and would otherwise satisfy this.
    expect(screen.queryByText(/\d{2}:\d{2}:\d{2} •/)).not.toBeInTheDocument()
  })

  // Regression: the user's own turn went through Streamdown too, so `<div>`
  // was parsed as an HTML tag and dropped, `__init__` became italics, and
  // `# comment` became an H1. A transcript has to show what the user sent.
  it('keeps a user message literal instead of reading it as markdown', () => {
    render(
      <MessagesTimeline
        view={view([item({ id: 'u1', kind: 'user', text: 'wrap it in a <div> tag, rename __init__ and fix # comment' })])}
      />,
    )

    expect(screen.getByText('wrap it in a <div> tag, rename __init__ and fix # comment')).toBeInTheDocument()
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  it('keeps both lines of a Shift+Enter user message', () => {
    render(<MessagesTimeline view={view([item({ id: 'u1', kind: 'user', text: 'add rate limiting\nalso add tests' })])} />)

    const bubble = screen.getByText(/add rate limiting/)
    expect(bubble.textContent).toBe('add rate limiting\nalso add tests')
    expect(bubble.className).toContain('whitespace-pre-wrap')
  })

  // Regression: markdown collapses a single newline into a space, so agent
  // narration rendered as one run-on line where the old pre-wrap bubble showed
  // three.
  it('keeps hard line breaks in assistant prose', () => {
    const { container } = render(
      <MessagesTimeline
        view={view([item({ id: 'a1', kind: 'assistant', text: 'Done.\nNext I will run the tests.\nThen I will commit.' })])}
      />,
    )

    expect(container.querySelectorAll('br')).toHaveLength(2)
  })

  it('still renders an assistant markdown list as a list', () => {
    render(<MessagesTimeline view={view([item({ id: 'a1', kind: 'assistant', text: '- first\n- second' })])} />)

    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })

  // Regression: `ToolHeader` is unconditionally a CollapsibleTrigger, so a call
  // with no arguments (a zero-argument tool, or any call still in flight)
  // offered an expand chevron that revealed nothing.
  it('does not offer a disclosure on a tool row with no arguments', () => {
    render(<MessagesTimeline view={view([item({ id: 't1', kind: 'tool', toolName: 'Bash', status: 'done' })])} />)

    expect(screen.getByRole('button', { name: /bash/i })).toBeDisabled()
  })

  it('keeps the disclosure live on a tool row that has arguments', () => {
    render(
      <MessagesTimeline
        view={view([item({ id: 't1', kind: 'tool', toolName: 'Bash', status: 'done', input: { command: 'go test ./...' } })])}
      />,
    )

    expect(screen.getByRole('button', { name: /bash/i })).toBeEnabled()
  })

  // Regression: `completedAt` was the turn's last entry's CREATION stamp — for
  // a streamed reply, its time-to-first-token. A 47s turn read `• 3s`.
  it('stamps a turn with when it finished, not when its first token arrived', () => {
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'go', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }),
            item({ id: 'a1', kind: 'assistant', text: 'done', createdAt: 1_700_000_003_000, updatedAt: 1_700_000_047_000 }),
          ],
          { status: 'idle' },
        )}
      />,
    )

    expect(screen.getByText(/47s$/)).toBeInTheDocument()
  })

  it('stamps a turn ending in a tool group from its latest call', () => {
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'go', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }),
            item({ id: 't1', kind: 'tool', toolName: 'Read', status: 'done', createdAt: 1_700_000_005_000, updatedAt: 1_700_000_008_000 }),
            item({ id: 't2', kind: 'tool', toolName: 'Edit', status: 'done', createdAt: 1_700_000_009_000, updatedAt: 1_700_000_040_000 }),
          ],
          { status: 'idle' },
        )}
      />,
    )

    expect(screen.getByText(/40s$/)).toBeInTheDocument()
  })

  // The spec listed copy actions as missing outright. Fenced code gets
  // Streamdown's own copy button; prose had nothing.
  it('offers a copy action on an assistant message', async () => {
    const user = userEvent.setup()
    render(<MessagesTimeline view={view([item({ id: 'a1', kind: 'assistant', text: 'the limiter is in place' })])} />)

    await user.click(screen.getByRole('button', { name: /copy/i }))
    await expect(window.navigator.clipboard.readText()).resolves.toBe('the limiter is in place')
  })

  it('does not offer a copy action on the user’s own message', () => {
    render(<MessagesTimeline view={view([item({ id: 'u1', kind: 'user', text: 'hello' })])} />)

    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument()
  })

  it('does not stamp the trailing turn while the agent is waiting on the user', () => {
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'go', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }),
            item({ id: 't1', kind: 'tool', toolName: 'Bash', status: 'running', createdAt: 1_700_000_003_000 }),
          ],
          { status: 'waiting' },
        )}
      />,
    )

    expect(screen.queryByText(/\ds$/)).not.toBeInTheDocument()
  })

  it('warns when the stream had a sequence gap', () => {
    render(<MessagesTimeline view={view([item({ id: 'a1', kind: 'assistant', text: 'hi' })], { hasGap: true })} />)

    expect(screen.getByText(/updates may be missing/i)).toBeInTheDocument()
  })
})

describe('MessagesTimeline plan entries', () => {
  // T11: `buildTimeline` (T9) already emits a `PlanEntry` for a `'plan'`
  // `ChatItem` — this is the render side, wiring that entry to
  // `ProposedPlanCard` rather than letting it fall into the `ToolGroupRow`
  // branch (which would crash on a missing `items` array; see the `else`
  // fallback at MessagesTimeline.tsx before this task).
  it('renders a plan item as a ProposedPlanCard, with the item text as its markdown', () => {
    render(
      <MessagesTimeline
        view={view([item({ id: 'p1', kind: 'plan', text: 'Wire the auth callback to redirect users after login.' })])}
      />,
    )

    // The "Plan" pill and the actions menu only exist on `ProposedPlanCard` —
    // their presence proves the plan entry routed there, not into a message
    // or tool-group row.
    expect(screen.getByText('Plan')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Plan actions' })).toBeInTheDocument()
    expect(screen.getByText('Wire the auth callback to redirect users after login.')).toBeInTheDocument()
  })

  // Regression guard on `entryKey` (MessagesTimeline.tsx:53-56): it already
  // falls through to the generic `entry.item.id` for any non-`tool-group`
  // kind, so no change was needed for `PlanEntry` — but this pins it. If a
  // future edit keyed plan rows by array index instead, prepending an entry
  // ahead of the plan would shift its index and React would tear down and
  // remount the card at its new position, losing the identity this test
  // checks for.
  it('keeps the plan card mounted at the same DOM node when it shifts position in the list', () => {
    const planItem = item({ id: 'p1', kind: 'plan', text: 'Wire the auth callback to redirect users after login.' })
    const otherItem = item({ id: 'a0', kind: 'assistant', text: 'Looking into it.' })

    const { rerender } = render(<MessagesTimeline view={view([planItem])} />)
    const before = screen.getByRole('button', { name: 'Plan actions' })

    rerender(<MessagesTimeline view={view([otherItem, planItem])} />)
    const after = screen.getByRole('button', { name: 'Plan actions' })

    expect(after).toBe(before)
  })
})

describe('MessagesTimeline turn footer', () => {
  const TURN = [
    item({ id: 'u1', kind: 'user', text: 'hi', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }),
    item({
      id: 'a1',
      kind: 'assistant',
      text: 'Hi! What are you working on today?',
      createdAt: 1_700_000_002_000,
      updatedAt: 1_700_000_008_000,
      turnTokens: 12_400,
      turnOutputTokens: 800,
    }),
  ]

  // The reported defect: the copy glyph sat on a line of its own ABOVE the
  // timestamp. Both now live in one row, so they share a parent.
  it('puts the copy action and the turn stamp in the same row', () => {
    render(<MessagesTimeline view={view(TURN, { status: 'idle' })} />)

    const copy = screen.getByRole('button', { name: 'Copy message' })
    const stamp = screen.getByText(/12k tokens/)
    const row = copy.closest('div')?.parentElement
    expect(row).not.toBeNull()
    expect(row).toContainElement(stamp)
  })

  it('shows the turn spend and an output-derived rate', () => {
    render(<MessagesTimeline view={view(TURN, { status: 'idle' })} />)

    // 800 generated over the turn's 8s.
    expect(screen.getByText(/12k tokens · 100 tok\/s/)).toBeInTheDocument()
  })

  it('falls back to the plain stamp when the provider reported no usage', () => {
    const noUsage = [
      TURN[0],
      item({ id: 'a1', kind: 'assistant', text: 'ok', createdAt: 1_700_000_002_000, updatedAt: 1_700_000_008_000 }),
    ]
    render(<MessagesTimeline view={view(noUsage, { status: 'idle' })} />)

    expect(screen.getByText(/• 8s$/)).toBeInTheDocument()
    expect(screen.queryByText(/tok\/s/)).not.toBeInTheDocument()
  })
})

describe('MessagesTimeline code folding', () => {
  // The seam, not the component: `CollapsibleCodeBlock.test.tsx` proves the fold
  // logic in isolation, but only Streamdown can prove it actually routes a
  // fenced block through `components.pre`. Wire this up wrong and every code
  // block silently renders full-height exactly as before.
  it('folds a long fenced block in an agent reply', async () => {
    const code = Array.from({ length: 40 }, (_, i) => `fmt.Println(${i})`).join('\n')
    render(<MessagesTimeline view={view([item({ id: 'a1', kind: 'assistant', text: `Here it is:\n\n\`\`\`go\n${code}\n\`\`\`\n` })])} />)

    const toggle = await screen.findByRole('button', { name: /40 lines of go/ })
    expect(screen.queryByText(/fmt.Println\(39\)/)).not.toBeInTheDocument()

    await userEvent.click(toggle)
    expect(await screen.findByText(/fmt.Println\(39\)/)).toBeInTheDocument()
  })

  it('leaves a short fenced block alone', () => {
    render(<MessagesTimeline view={view([item({ id: 'a1', kind: 'assistant', text: 'run:\n\n```sh\ngo test ./...\n```\n' })])} />)

    expect(screen.queryByRole('button', { name: /lines? of/ })).not.toBeInTheDocument()
  })
})

describe('MessagesTimeline working indicator', () => {
  // The whole point of the row: the operator could not tell a thinking agent
  // from a hung one. It used to hide itself the moment anything else appeared on
  // screen, so for most of a turn's duration nothing on the page claimed to be
  // in progress.
  it('keeps counting while the agent is already streaming a reply', () => {
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'go', createdAt: 1_700_000_000_000 }),
            item({ id: 'a1', kind: 'assistant', text: 'partial answer', createdAt: 1_700_000_003_000 }),
          ],
          { status: 'running' },
        )}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent(/Working for \d+s/)
  })

  it('keeps counting while a tool row is the newest thing on screen', () => {
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'go', createdAt: 1_700_000_000_000 }),
            item({ id: 't1', kind: 'tool', toolName: 'Bash', status: 'running', createdAt: 1_700_000_002_000 }),
          ],
          { status: 'running' },
        )}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent(/Working for \d+s/)
  })

  // Regression: the count came from the newest item's `updatedAt`, which
  // advances on every streamed token — so the timer restarted continuously and
  // the row read "Working for 0s" for the whole turn. It counts from the user's
  // own message instead, which is the only stable start of a turn.
  it('counts from the user turn, not from the last token that arrived', () => {
    const started = Date.now() - 30_000
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'go', createdAt: started }),
            item({ id: 'a1', kind: 'assistant', text: 'still going', createdAt: started + 1_000, updatedAt: Date.now() }),
          ],
          { status: 'running' },
        )}
      />,
    )

    // ~30s since the user asked, NOT ~0s since the last token landed.
    expect(screen.getByRole('status')).toHaveTextContent(/Working for (29|30|31)s/)
  })

  it('says nothing about a thread that is not running', () => {
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'go', createdAt: 1_700_000_000_000 }),
            item({ id: 'a1', kind: 'assistant', text: 'done', createdAt: 1_700_000_003_000 }),
          ],
          { status: 'idle' },
        )}
      />,
    )

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

describe('MessagesTimeline error state', () => {
  // Belt and braces alongside the reducer fix: even handed a view that still
  // claims to be running, a turn that ended in an error must not also be
  // counting "Working for …". Two contradictory things on screen at once is
  // what made the stuck turn unreadable.
  it('shows the error and no working indicator', () => {
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'whats your model?', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }),
            item({ id: 'e1', kind: 'error', text: 'provider unreachable', createdAt: 1_700_000_003_000, updatedAt: 1_700_000_003_000 }),
          ],
          { status: 'running' },
        )}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('provider unreachable')
    expect(screen.queryByText(/Working for/)).not.toBeInTheDocument()
  })
})

// Composer-context-attachments plan, T11 (C2): the user bubble's thumbnail
// strip. This plan's own opening section corrects the spec's original claim
// that `GET /api/agent/attachments/{id}` can be used as a plain `<img src>`
// — a runtime's key-only auth rejects `?key=` on a non-upgrade request, so
// the thumbnail must be fetched as a blob and rendered as an object URL.
describe('MessagesTimeline — attachments', () => {
  const machine: Machine = { id: 'm-1', name: 'dev', url: 'http://localhost:9', key: 'k', isLocal: false, signingPublicKey: '' }

  beforeEach(() => {
    fetchAgentAttachmentBlobMock.mockReset()
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:attachment-preview'),
      revokeObjectURL: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders a thumbnail fetched as a blob, not sourced from the raw attachments route', async () => {
    fetchAgentAttachmentBlobMock.mockResolvedValue(new Blob(['x'], { type: 'image/png' }))
    render(
      <MessagesTimeline
        machine={machine}
        view={view([
          item({
            id: 'u1',
            kind: 'user',
            text: 'look at this',
            attachments: [{ id: 'att-1', kind: 'image', mime: 'image/png', name: 'shot.png' }],
          }),
        ])}
      />,
    )

    const img = await screen.findByAltText('shot.png')
    expect(img).toHaveAttribute('src', 'blob:attachment-preview')
    expect(img.getAttribute('src')).not.toMatch(/\/api\/agent\/attachments\//)
    expect(fetchAgentAttachmentBlobMock).toHaveBeenCalledWith(machine, 'att-1')
    expect(screen.getByText('look at this')).toBeInTheDocument()
  })

  it('renders one thumbnail per attachment on the same message', async () => {
    fetchAgentAttachmentBlobMock.mockResolvedValue(new Blob(['x'], { type: 'image/png' }))
    render(
      <MessagesTimeline
        machine={machine}
        view={view([
          item({
            id: 'u1',
            kind: 'user',
            text: '',
            attachments: [
              { id: 'att-1', kind: 'image', mime: 'image/png', name: 'a.png' },
              { id: 'att-2', kind: 'image', mime: 'image/png', name: 'b.png' },
            ],
          }),
        ])}
      />,
    )

    expect(await screen.findByAltText('a.png')).toBeInTheDocument()
    expect(await screen.findByAltText('b.png')).toBeInTheDocument()
    // An image-only message has no "…" placeholder standing in for absent text.
    expect(screen.queryByText('…')).not.toBeInTheDocument()
  })

  it('shows an explicit failure affordance when the blob fetch fails, rather than a broken image', async () => {
    fetchAgentAttachmentBlobMock.mockRejectedValue(new Error('404'))
    render(
      <MessagesTimeline
        machine={machine}
        view={view([
          item({
            id: 'u1',
            kind: 'user',
            text: 'oops',
            attachments: [{ id: 'att-missing', kind: 'image', mime: 'image/png', name: 'gone.png' }],
          }),
        ])}
      />,
    )

    await waitFor(() => expect(screen.getByRole('img', { name: /gone\.png failed to load/i })).toBeInTheDocument())
    expect(screen.queryByAltText('gone.png')).not.toBeInTheDocument()
  })

  it('a message with no attachments renders no thumbnail strip and never calls fetchAgentAttachmentBlob', () => {
    render(<MessagesTimeline machine={machine} view={view([item({ id: 'u1', kind: 'user', text: 'hello' })])} />)

    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(fetchAgentAttachmentBlobMock).not.toHaveBeenCalled()
  })
})

// Composer-context-attachments plan, T15 (C3): the second edit — a user
// message's trailing `<terminal_context>` block (T12's
// `buildTerminalContextBlock`, appended by `ChatComposer`'s own C3 bridge)
// must not dump raw terminal output into the transcript bubble.
describe('MessagesTimeline — terminal context (C3)', () => {
  function withContext(text: string, destination: string, capturedText: string): string {
    return buildTerminalContextBlock(text, [{ destination, text: capturedText }])
  }

  it('shows only the visible text, not the raw block, for a message with a trailing terminal_context block', () => {
    const raw = withContext('look at this error', 'terminal:sess-1/L1-L5', 'Error: boom\n  at foo')
    render(<MessagesTimeline view={view([item({ id: 'u1', kind: 'user', text: raw })])} />)

    expect(screen.getByText('look at this error')).toBeInTheDocument()
    expect(screen.queryByText(/terminal_context/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Error: boom/)).not.toBeInTheDocument()
  })

  it('shows a collapsible affordance with the context count', () => {
    const raw = withContext('look at this error', 'terminal:sess-1/L1-L5', 'Error: boom')
    render(<MessagesTimeline view={view([item({ id: 'u1', kind: 'user', text: raw })])} />)

    expect(screen.getByText('1 terminal context')).toBeInTheDocument()
  })

  it('pluralizes the count for more than one captured context', () => {
    const raw = buildTerminalContextBlock('two selections', [
      { destination: 'terminal:sess-1/L1-L2', text: 'one' },
      { destination: 'terminal:sess-1/L4-L4', text: 'two' },
    ])
    render(<MessagesTimeline view={view([item({ id: 'u1', kind: 'user', text: raw })])} />)

    expect(screen.getByText('2 terminal contexts')).toBeInTheDocument()
  })

  it('expanding the collapsible reveals the captured terminal output', async () => {
    const raw = withContext('look at this error', 'terminal:sess-1/L1-L5', 'Error: boom')
    render(<MessagesTimeline view={view([item({ id: 'u1', kind: 'user', text: raw })])} />)

    expect(screen.queryByText(/Error: boom/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('1 terminal context'))
    expect(screen.getByText(/Error: boom/)).toBeInTheDocument()
  })

  it('a message with no terminal_context block renders no collapsible and no copy action', () => {
    render(<MessagesTimeline view={view([item({ id: 'u1', kind: 'user', text: 'plain message' })])} />)

    expect(screen.queryByText(/terminal context/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /copy/i })).not.toBeInTheDocument()
  })

  it('copying the message yields the full text, including the stripped block', async () => {
    const user = userEvent.setup()
    const raw = withContext('look at this error', 'terminal:sess-1/L1-L5', 'Error: boom')
    render(<MessagesTimeline view={view([item({ id: 'u1', kind: 'user', text: raw })])} />)

    await user.click(screen.getByRole('button', { name: /copy/i }))
    await expect(window.navigator.clipboard.readText()).resolves.toBe(raw)
  })
})

// ── the changed-files card ───────────────────────────────────────────────────
//
// Derived from the turn's own tool calls rather than from a diff, so it works
// on an SSH thread whose files live on a remote host — see `changedFiles.ts`.
describe('MessagesTimeline — changed files', () => {
  const turn = (extra: ChatItem[] = []) => [
    item({ id: 'u1', kind: 'user', text: 'write the script', createdAt: 1_700_000_000_000 }),
    item({ id: 't1', kind: 'tool', toolName: 'Write', status: 'done', input: { file_path: 'scripts/migrate.sh' } }),
    item({ id: 't2', kind: 'tool', toolName: 'Edit', status: 'done', input: { file_path: '.gitignore' } }),
    ...extra,
    item({ id: 'a1', kind: 'assistant', text: 'done', createdAt: 1_700_000_010_000 }),
  ]

  it('summarises what a settled turn wrote', () => {
    render(<MessagesTimeline view={view(turn(), { status: 'idle' })} />)

    expect(screen.getByText('2 changed files')).toBeInTheDocument()
    expect(screen.getByTitle('scripts/migrate.sh · Write')).toBeInTheDocument()
    expect(screen.getByTitle('.gitignore · Edit')).toBeInTheDocument()
  })

  // Files reached through a tool GROUP, which is where `buildTimeline` puts a
  // run of consecutive calls — a per-entry walk would never see them.
  it('finds files inside a collapsed run of tool calls', () => {
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'go', createdAt: 1_700_000_000_000 }),
            item({ id: 't1', kind: 'tool', toolName: 'Write', status: 'done', input: { file_path: 'a.ts' } }),
            item({ id: 't2', kind: 'tool', toolName: 'Write', status: 'done', input: { file_path: 'b.ts' } }),
            item({ id: 't3', kind: 'tool', toolName: 'Write', status: 'done', input: { file_path: 'c.ts' } }),
          ],
          { status: 'idle' },
        )}
      />,
    )
    // collapseWorkLog leaves only the newest call visible, so two of these
    // three rows are folded away — the card still counts all three.
    expect(screen.getByText('3 changed files')).toBeInTheDocument()
  })

  it('says nothing for a turn that only read', () => {
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'look', createdAt: 1_700_000_000_000 }),
            item({ id: 't1', kind: 'tool', toolName: 'Read', status: 'done', input: { file_path: 'a.ts' } }),
            item({ id: 'a1', kind: 'assistant', text: 'seen', createdAt: 1_700_000_010_000 }),
          ],
          { status: 'idle' },
        )}
      />,
    )
    expect(screen.queryByText(/changed file/)).not.toBeInTheDocument()
  })

  // Same rule as the turn stamp: a turn still running has not finished
  // writing, and a count that climbs while you read it invites a review of a
  // list that is not final.
  it('waits for the turn to settle before summarising it', () => {
    render(<MessagesTimeline view={view(turn(), { status: 'running' })} />)
    expect(screen.queryByText(/changed file/)).not.toBeInTheDocument()
  })

  it('scopes each card to its own turn', () => {
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'one', createdAt: 1_700_000_000_000 }),
            item({ id: 't1', kind: 'tool', toolName: 'Write', status: 'done', input: { file_path: 'a.ts' } }),
            item({ id: 'a1', kind: 'assistant', text: 'first', createdAt: 1_700_000_010_000 }),
            item({ id: 'u2', kind: 'user', text: 'two', createdAt: 1_700_000_020_000 }),
            item({ id: 't2', kind: 'tool', toolName: 'Write', status: 'done', input: { file_path: 'b.ts' } }),
            item({ id: 'a2', kind: 'assistant', text: 'second', createdAt: 1_700_000_030_000 }),
          ],
          { status: 'idle' },
        )}
      />,
    )
    // Two turns, one file each — not one card claiming two.
    expect(screen.getAllByText('1 changed file')).toHaveLength(2)
  })
})

describe('MessagesTimeline — notices', () => {
  it('renders a DevDeck refusal as a visible, non-alarming row', () => {
    render(
      <MessagesTimeline
        view={view([
          item({ id: 'u1', kind: 'user', text: 'make a plan' }),
          item({ id: 'n1', kind: 'notice', text: 'ExitPlanMode was not allowed to run. Plan captured by DevDeck.' }),
        ])}
      />,
    )
    const row = screen.getByText(/ExitPlanMode was not allowed to run/)
    expect(row).toBeInTheDocument()
    // A refusal is not a failure: no alert role, and the red ErrorRow treatment
    // is reserved for something that actually broke.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(row.closest('[role="status"]')).not.toBeNull()
  })

  it('still renders a real error as an alert', () => {
    render(<MessagesTimeline view={view([item({ id: 'e1', kind: 'error', text: 'claude exited 1' })])} />)
    expect(screen.getByRole('alert')).toHaveTextContent('claude exited 1')
  })
})

/**
 * A thread that has run for a while reaches hundreds of entries, and every
 * agent message in one is a full markdown parse. Mounting all of them at once
 * is seconds of blocked main thread for history nobody scrolled to — see
 * `INITIAL_VISIBLE_ENTRIES`.
 */
describe('MessagesTimeline / long threads', () => {
  /** `n` alternating user/assistant messages, each its own timeline entry. */
  function longThread(n: number): ChatItem[] {
    return Array.from({ length: n }, (_, i) =>
      item({ id: `m${i}`, kind: i % 2 === 0 ? 'user' : 'assistant', text: `message ${i}` }),
    )
  }

  it('renders a short thread whole, with no window control', () => {
    render(<MessagesTimeline view={view(longThread(10))} />)

    expect(screen.getByText('message 0')).toBeInTheDocument()
    expect(screen.getByText('message 9')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /show earlier/i })).not.toBeInTheDocument()
  })

  it('opens a long thread on its live edge and folds the rest', () => {
    render(<MessagesTimeline view={view(longThread(300))} />)

    // The newest turn is what the reader needs first, and it is present.
    expect(screen.getByText('message 299')).toBeInTheDocument()
    // The oldest is not mounted at all — that is the whole point.
    expect(screen.queryByText('message 0')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show earlier/i })).toBeInTheDocument()
  })

  it('reveals more history on request, and all of it on demand', async () => {
    const user = userEvent.setup()
    render(<MessagesTimeline view={view(longThread(300))} />)

    const before = screen.queryAllByText(/^message \d+$/).length
    await user.click(screen.getByRole('button', { name: /show earlier/i }))
    expect(screen.queryAllByText(/^message \d+$/).length).toBeGreaterThan(before)

    await user.click(screen.getByRole('button', { name: /show all/i }))
    expect(screen.getByText('message 0')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /show earlier/i })).not.toBeInTheDocument()
  })

  it('states how much history is folded rather than hiding it silently', () => {
    render(<MessagesTimeline view={view(longThread(300))} />)

    expect(screen.getByRole('button', { name: /\d+ entries above/i })).toBeInTheDocument()
  })
})

/**
 * Regression: the window is anchored to the START of the thread, not sized
 * from its end. A live turn appends entries at the bottom; if the window shed
 * one entry off the top per streamed token, that top unmount is a NEGATIVE
 * content resize and `use-stick-to-bottom` only re-pins to the bottom on a
 * positive one — so the reply streamed on while the viewport stopped following
 * it (rendered, but below the fold). These pin the anchor that prevents it.
 */
describe('MessagesTimeline / window is anchored, not sized from the end', () => {
  function thread(n: number, opts: { anchorId?: string } = {}): ChatItem[] {
    return Array.from({ length: n }, (_, i) =>
      item({
        id: i === 0 && opts.anchorId ? opts.anchorId : `m${i}`,
        kind: i % 2 === 0 ? 'user' : 'assistant',
        text: `message ${i}`,
      }),
    )
  }

  it('does not unmount already-visible entries while a turn streams', () => {
    // `running` is what streaming is: the cut freezes so new tokens only grow
    // the bottom. (When settled, the window instead tracks the tail — see the
    // chunked-replay test below.)
    const { rerender } = render(<MessagesTimeline view={view(thread(300), { status: 'running' })} />)
    // Newest 80 shown; the top of the window is message 220.
    expect(screen.getByText('message 220')).toBeInTheDocument()
    expect(screen.queryByText('message 219')).not.toBeInTheDocument()

    // Two more entries stream in — the same thread (m0 still first).
    rerender(<MessagesTimeline view={view(thread(302), { status: 'running' })} />)

    // The newest are shown...
    expect(screen.getByText('message 301')).toBeInTheDocument()
    // ...and the top of the window has NOT advanced: message 220 is still
    // mounted. A count-from-the-end window would have dropped 220 and 221 —
    // the negative resize that broke the scroll lock.
    expect(screen.getByText('message 220')).toBeInTheDocument()
  })

  it('resets the window to the live edge when the pane switches threads', () => {
    const { rerender } = render(<MessagesTimeline view={view(thread(300, { anchorId: 'A0' }))} />)
    expect(screen.queryByText('message 0')).not.toBeInTheDocument()

    // A different thread (different first-item id), short enough to show whole.
    rerender(<MessagesTimeline view={view(thread(5, { anchorId: 'B0' }))} />)

    expect(screen.getByText('message 4')).toBeInTheDocument()
    expect(screen.getByText('message 1')).toBeInTheDocument()
    // No stale fold carried over from the long thread.
    expect(screen.queryByRole('button', { name: /show earlier/i })).not.toBeInTheDocument()
  })
})

/**
 * #185 hunt: React "Maximum update depth exceeded" is a setState-during-render
 * loop. The window's thread-anchor reset is the only setState-during-render in
 * this component, so stress the exact triggers — rapid streaming growth and
 * repeated thread switches, under StrictMode's double-invoke.
 */
describe('MessagesTimeline / no render loop (#185)', () => {
  function thread(n: number, anchorId: string): ChatItem[] {
    return Array.from({ length: n }, (_, i) =>
      item({ id: i === 0 ? anchorId : `${anchorId}-m${i}`, kind: i % 2 === 0 ? 'user' : 'assistant', text: `${anchorId} ${i}` }),
    )
  }

  it('survives rapid streaming growth without an update-depth loop', () => {
    const { rerender } = render(
      <StrictMode>
        <MessagesTimeline view={view(thread(200, 'A'))} />
      </StrictMode>,
    )
    for (let n = 201; n <= 260; n++) {
      rerender(
        <StrictMode>
          <MessagesTimeline view={view(thread(n, 'A'), { status: 'running' })} />
        </StrictMode>,
      )
    }
    expect(screen.getByText('A 259')).toBeInTheDocument()
  })

  it('survives repeated thread switches without an update-depth loop', () => {
    const { rerender } = render(
      <StrictMode>
        <MessagesTimeline view={view(thread(150, 'A'))} />
      </StrictMode>,
    )
    for (let i = 0; i < 12; i++) {
      const id = i % 2 === 0 ? 'B' : 'A'
      rerender(
        <StrictMode>
          <MessagesTimeline view={view(thread(150, id))} />
        </StrictMode>,
      )
    }
    expect(screen.getByText('A 149')).toBeInTheDocument()
  })
})

/**
 * #185 hunt, streaming paths. The earlier stress test used only user/assistant
 * items; the live turn in the report streamed a reasoning block then a text
 * answer, and those hit the vendored `Reasoning` (effects + Radix
 * `useControllableState`) and `MessageResponse` (Streamdown) — neither
 * exercised before. Simulate the token-by-token growth the socket produces.
 */
describe('MessagesTimeline / streaming render has no update-depth loop (#185)', () => {
  function streamingView(reasoningText: string, answerText: string, createdAt: number, updatedAt: number): AgentThreadView {
    return view(
      [
        item({ id: 'u1', kind: 'user', text: 'go', createdAt, updatedAt: createdAt }),
        item({ id: 'r1', kind: 'reasoning', text: reasoningText, createdAt, updatedAt }),
        ...(answerText ? [item({ id: 'a1', kind: 'assistant', text: answerText, createdAt, updatedAt })] : []),
      ],
      { status: 'running' },
    )
  }

  it('streams a reasoning block then a text answer without looping', () => {
    const t0 = 1_000_000
    const { rerender } = render(
      <StrictMode>
        <MessagesTimeline view={streamingView('The', '', t0, t0)} />
      </StrictMode>,
    )
    // Reasoning streams: updatedAt advances so reasoningDuration crosses 0 -> N,
    // which flips the vendored `duration` prop uncontrolled -> controlled.
    let reasoning = 'The'
    for (let i = 1; i <= 20; i++) {
      reasoning += ' tok'
      rerender(
        <StrictMode>
          <MessagesTimeline view={streamingView(reasoning, '', t0, t0 + i * 500)} />
        </StrictMode>,
      )
    }
    // Then the text answer streams in as a second item.
    let answer = ''
    for (let i = 1; i <= 20; i++) {
      answer += ' word'
      rerender(
        <StrictMode>
          <MessagesTimeline view={streamingView(reasoning, answer, t0, t0 + (20 + i) * 500)} />
        </StrictMode>,
      )
    }
    expect(screen.getByText(/word word/)).toBeInTheDocument()
  })

  it('settles from running to idle (stream end) without looping', () => {
    const t0 = 2_000_000
    const { rerender } = render(
      <StrictMode>
        <MessagesTimeline view={streamingView('thinking a lot here', 'answer text', t0, t0 + 5000)} />
      </StrictMode>,
    )
    // The closing session-set flips status running -> idle; the vendored
    // Reasoning fires its stream-ended effect (setDuration/auto-close).
    rerender(
      <StrictMode>
        <MessagesTimeline
          view={view(
            [
              item({ id: 'u1', kind: 'user', text: 'go', createdAt: t0, updatedAt: t0 }),
              item({ id: 'r1', kind: 'reasoning', text: 'thinking a lot here', createdAt: t0, updatedAt: t0 + 5000 }),
              item({ id: 'a1', kind: 'assistant', text: 'answer text', createdAt: t0, updatedAt: t0 + 5000 }),
            ],
            { status: 'idle' },
          )}
        />
      </StrictMode>,
    )
    expect(screen.getByText('answer text')).toBeInTheDocument()
  })
})

/**
 * The replay now arrives in several frames (backend chunks it), so the FIRST
 * render sees only the first chunk. If the window anchor freezes on that first
 * render it points at the first chunk's tail, and every later chunk then
 * renders in full — the window stops limiting anything on reload, which is the
 * heavy mount that fights the scroll container.
 */
describe('MessagesTimeline / window must limit a chunked replay', () => {
  function thread(n: number): ChatItem[] {
    return Array.from({ length: n }, (_, i) =>
      item({ id: `m${i}`, kind: i % 2 === 0 ? 'user' : 'assistant', text: `message ${i}` }),
    )
  }

  it('keeps only the live edge visible after later replay chunks land', () => {
    // First render = first replay chunk (100 entries).
    const { rerender } = render(<MessagesTimeline view={view(thread(100), { status: 'idle' })} />)
    // Later chunks bring the same thread to 1400 entries, still idle (replay).
    rerender(<MessagesTimeline view={view(thread(1400), { status: 'idle' })} />)

    // A middle entry from the extra chunks must NOT be mounted — otherwise the
    // window limited nothing and we mounted ~1300 full-markdown rows.
    expect(screen.queryByText('message 700')).not.toBeInTheDocument()
    expect(screen.getByText('message 1399')).toBeInTheDocument()
  })
})

/**
 * The settled/running split's other half: once a turn ends the window must go
 * back to tracking the tail, so a long session doesn't accumulate every turn's
 * entries mounted forever. (During the turn it was frozen — see the streaming
 * test above.)
 */
describe('MessagesTimeline / re-windows when a turn settles', () => {
  function thread(n: number): ChatItem[] {
    return Array.from({ length: n }, (_, i) =>
      item({ id: `m${i}`, kind: i % 2 === 0 ? 'user' : 'assistant', text: `message ${i}` }),
    )
  }

  it('freezes the cut while running, then sheds the top once idle', () => {
    // Mid-stream: 300 entries, running -> cut frozen at 220.
    const { rerender } = render(<MessagesTimeline view={view(thread(300), { status: 'running' })} />)
    rerender(<MessagesTimeline view={view(thread(360), { status: 'running' })} />)
    // Frozen: the whole turn's growth stayed mounted, top did not advance.
    expect(screen.getByText('message 220')).toBeInTheDocument()

    // Turn ends: settle to idle at 360 entries. Window re-tracks the tail (280).
    rerender(<MessagesTimeline view={view(thread(360), { status: 'idle' })} />)
    expect(screen.getByText('message 359')).toBeInTheDocument()
    expect(screen.queryByText('message 220')).not.toBeInTheDocument()
  })
})

/**
 * The hard mount ceiling: the freeze rule can't cap a reattach to a thread
 * that is ALREADY mid-stream (its whole history arrives in replay chunks with
 * status already `running`, so the frozen cut sits at the first chunk's tail).
 * MAX_MOUNTED_ENTRIES catches that so a huge thread never mounts in full.
 */
describe('MessagesTimeline / hard mount ceiling', () => {
  function thread(n: number): ChatItem[] {
    return Array.from({ length: n }, (_, i) =>
      item({ id: `m${i}`, kind: i % 2 === 0 ? 'user' : 'assistant', text: `message ${i}` }),
    )
  }

  it('never mounts a whole huge thread even while running with a small frozen cut', () => {
    // Mount running at 100 (frozen cut ~20), then chunks grow it to 1400 while
    // STILL running — the freeze would keep the cut at 20 and mount ~1380.
    const { rerender } = render(<MessagesTimeline view={view(thread(100), { status: 'running' })} />)
    rerender(<MessagesTimeline view={view(thread(1400), { status: 'running' })} />)

    // The ceiling bit: an entry older than the last MAX_MOUNTED (400) is not
    // mounted, so ~1000 entries never rendered.
    expect(screen.queryByText('message 900')).not.toBeInTheDocument()
    // The live edge is still there.
    expect(screen.getByText('message 1399')).toBeInTheDocument()
  })
})


// ── The answered AskUserQuestion ──
//
// The card that ASKS lives in the composer and closes the instant it is
// answered, so before this row existed the exchange left no trace in the thread
// at all: not the question, not the pick, and nothing after a reload — while the
// agent's next turn was already acting on the answer.
describe('MessagesTimeline — answered questions', () => {
  const answered = item({
    id: 'q1',
    kind: 'question',
    createdAt: 5_000,
    updatedAt: 5_000,
    answeredQuestions: [
      {
        question: 'Is fixing IsManually() in scope?',
        header: 'Fix source check?',
        chosen: ['Yes, fix it'],
        descriptions: { 'Yes, fix it': 'Switch the condition to IsSemiAutomate().' },
      },
    ],
  })

  it('shows the question, the pick and the picked option description', () => {
    render(<MessagesTimeline view={view([answered])} />)

    expect(screen.getByText('You answered')).toBeInTheDocument()
    expect(screen.getByText('Is fixing IsManually() in scope?')).toBeInTheDocument()
    expect(screen.getByText('Yes, fix it')).toBeInTheDocument()
    expect(screen.getByText('Switch the condition to IsSemiAutomate().')).toBeInTheDocument()
  })

  it('labels each question of a multi-question request and lists every pick', () => {
    const multi = item({
      id: 'q2',
      kind: 'question',
      answeredQuestions: [
        { question: 'Which files?', header: 'Scope', chosen: ['api', 'usecase'] },
        { question: 'Run the tests?', header: 'Verify', chosen: ['Yes'] },
      ],
    })
    render(<MessagesTimeline view={view([multi])} />)

    expect(screen.getByText('2 questions')).toBeInTheDocument()
    expect(screen.getByText('Scope')).toBeInTheDocument()
    expect(screen.getByText('Verify')).toBeInTheDocument()
    for (const pick of ['api', 'usecase', 'Yes']) {
      expect(screen.getByText(pick)).toBeInTheDocument()
    }
  })

  // Every other bubble-less row had this bug too: the stamp was handed to a
  // `MessageRow` footer that is never rendered for these kinds, so a turn
  // ending on one showed no timings at all.
  it('keeps the turn stamp on a turn that ends on an answered question', () => {
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'go', createdAt: 1_000, updatedAt: 1_000 }),
            { ...answered, turnTokens: 1_200, turnOutputTokens: 400 },
          ],
          { status: 'idle' },
        )}
      />,
    )

    expect(screen.getByText(/1\.2k tokens/)).toBeInTheDocument()
  })

  it('renders nothing for a question row that carries no answers', () => {
    render(<MessagesTimeline view={view([item({ id: 'q3', kind: 'question' })])} />)

    expect(screen.queryByText('You answered')).not.toBeInTheDocument()
  })
})

// ── Subagents ───────────────────────────────────────────────────────────────
//
// A delegated job costs the parent's narrative exactly one row, whatever it
// does inside; the detail is one click below. See
// `docs/superpowers/specs/2026-08-26-subagent-observability-design.md`.
describe('MessagesTimeline — subagent row', () => {
  const AGENT = 'toolu_spawn_1'

  function subagentView(overrides: Partial<AgentThreadView['subagents'][number]> = {}, items: ChatItem[] = []) {
    return view(
      [
        item({ id: 'p1', kind: 'assistant', text: 'I will delegate this.' }),
        ...items.map((i) => ({ ...i, agentId: AGENT })),
      ],
      {
        subagents: [
          {
            id: AGENT,
            toolCallId: AGENT,
            title: 'Run three echo commands',
            role: 'general-purpose',
            status: 'running',
            createdAt: 1,
            updatedAt: 2,
            ...overrides,
          },
        ],
      },
    )
  }

  it('names the job, its role and what it has spent', () => {
    render(
      <MessagesTimeline
        view={subagentView({ status: 'completed', usage: { totalTokens: 21449, toolUses: 3 } })}
      />,
    )

    expect(screen.getByText('Run three echo commands')).toBeInTheDocument()
    expect(screen.getByText(/general-purpose/)).toBeInTheDocument()
    expect(screen.getByText(/Completed · 21k tokens · 3 tools/)).toBeInTheDocument()
  })

  // The progress line is the only sign of life while an agent works, so it
  // renders OUTSIDE the fold — hiding it would put the one thing worth
  // reading where nobody is looking.
  it('shows the live progress line without expanding anything', () => {
    render(<MessagesTimeline view={subagentView({ progress: 'Running Print CHARLIE' })} />)
    expect(screen.getByText('Running Print CHARLIE')).toBeInTheDocument()
  })

  // Once it is done, the report back replaces the now-finished progress tick.
  it('shows the report back in place of progress once it settles', () => {
    render(
      <MessagesTimeline
        view={subagentView({ status: 'completed', progress: 'Running Print CHARLIE', summary: 'Ran all three.' })}
      />,
    )
    expect(screen.queryByText('Running Print CHARLIE')).not.toBeInTheDocument()
    expect(screen.getByText('Ran all three.')).toBeInTheDocument()
  })

  it('keeps the agent’s own work behind a disclosure, and reveals it on click', async () => {
    render(
      <MessagesTimeline
        view={subagentView({ status: 'completed' }, [
          item({ id: 'c1', kind: 'tool', toolName: 'Bash', status: 'done', input: { command: 'echo ALPHA' } }),
          item({ id: 'c2', kind: 'assistant', text: 'I ran all three.' }),
        ])}
      />,
    )

    // Collapsed: the parent's own message is on screen, the agent's is not.
    expect(screen.getByText('I will delegate this.')).toBeInTheDocument()
    expect(screen.queryByText('I ran all three.')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Run three echo commands/ }))

    expect(await screen.findByText('I ran all three.')).toBeInTheDocument()
    // The agent's tool call renders as a real tool row — name and the
    // argument that identifies it. (`ToolCompactHeader` writes "Bash:" when
    // it has a summary to put behind the name.)
    expect(screen.getByText(/^Bash:?$/)).toBeInTheDocument()
    expect(screen.getByText('echo ALPHA')).toBeInTheDocument()
  })

  // Nothing to disclose while it is starting up — a chevron that expands to
  // nothing is worse than no chevron.
  it('is inert until it has produced something', () => {
    render(<MessagesTimeline view={subagentView()} />)
    expect(screen.getByRole('button', { name: /Run three echo commands/ })).toBeDisabled()
  })
})

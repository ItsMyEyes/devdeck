import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

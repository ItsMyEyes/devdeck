import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MessagesTimeline } from '@/features/agent-chat/MessagesTimeline'
import { emptyThreadView } from '@/features/agent-chat/eventReducer'
import type { AgentThreadView, ChatItem } from '@/features/agent-chat/types'

// Shiki compiles a real grammar and (depending on the engine) reaches for
// WASM, which is slow-to-impossible under jsdom. ToolInput renders a
// CodeBlock, so stub the vendored module: these tests are about which rows
// appear and what they say, not about highlighting.
vi.mock('@/components/ai-elements/code-block', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
  CodeBlockCopyButton: () => null,
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
    // The vendored ReasoningTrigger's default label is "Thought for a few
    // seconds" (from `defaultGetThinkingMessage` in reasoning.tsx), not
    // anything containing the word "reasoning".
    await userEvent.click(screen.getByRole('button', { name: /thought for a few seconds/i }))
    expect(screen.getByText(/thinking about the limiter/)).toBeInTheDocument()
  })

  it('shows a tool call with its name and its Running badge', () => {
    render(<MessagesTimeline view={view([item({ id: 't1', kind: 'tool', toolName: 'Edit', status: 'running' })])} />)

    expect(screen.getByText('Edit')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
  })

  it('reveals the tool arguments when the row is expanded', async () => {
    render(
      <MessagesTimeline
        view={view([item({ id: 't1', kind: 'tool', toolName: 'Edit', status: 'done', input: { file_path: '/a/b.go' } })])}
      />,
    )

    await userEvent.click(screen.getByText('Edit'))
    expect(screen.getByTestId('code-block')).toHaveTextContent('"file_path": "/a/b.go"')
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

    expect(screen.queryByText(/\ds$/)).not.toBeInTheDocument()
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

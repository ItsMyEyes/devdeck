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

  it('warns when the stream had a sequence gap', () => {
    render(<MessagesTimeline view={view([item({ id: 'a1', kind: 'assistant', text: 'hi' })], { hasGap: true })} />)

    expect(screen.getByText(/updates may be missing/i)).toBeInTheDocument()
  })
})

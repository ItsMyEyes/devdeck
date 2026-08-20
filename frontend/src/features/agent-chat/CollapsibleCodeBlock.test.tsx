import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CollapsibleCodeBlock } from '@/features/agent-chat/CollapsibleCodeBlock'

afterEach(() => {
  cleanup()
})

// Streamdown hands the `pre` renderer one child: the `<code>` element carrying
// the fence's source as its children and `language-<lang>` in its className.
// Rendering that shape directly keeps these tests off shiki, which compiles a
// real grammar and is slow-to-impossible under jsdom.
function fence(source: string, language?: string) {
  return (
    <CollapsibleCodeBlock>
      <code className={language ? `language-${language}` : undefined}>{source}</code>
    </CollapsibleCodeBlock>
  )
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

describe('CollapsibleCodeBlock', () => {
  it('leaves a short block unfolded, with the header but no fold control', () => {
    render(fence(lines(4), 'go'))

    expect(screen.getByText(/line 4/)).toBeInTheDocument()
    // A toggle above a four-line snippet is more chrome than the snippet — the
    // wrap and copy actions are not, and ride on every fence.
    expect(screen.queryByRole('button', { name: /lines of/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Wrap lines' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
  })

  it('folds a long block away and says what it is hiding', () => {
    render(fence(lines(68), 'go'))

    expect(screen.getByRole('button', { name: /68 lines of go/ })).toBeInTheDocument()
    expect(screen.queryByText(/line 68/)).not.toBeInTheDocument()
  })

  it('shows and hides the block again on click', async () => {
    render(fence(lines(30), 'ts'))

    const toggle = screen.getByRole('button', { name: /30 lines of ts/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(/line 30/)).toBeInTheDocument()

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(/line 30/)).not.toBeInTheDocument()
  })

  // A fence opened as ``` with no language still has to label its own fold.
  it('labels a fold with no language by its line count alone', () => {
    render(fence(lines(20)))

    expect(screen.getByRole('button', { name: '20 lines' })).toBeInTheDocument()
  })

  it('does not count the trailing newline a fence ends with as a line', () => {
    // Exactly at the threshold once the trailing newline is discounted, so an
    // off-by-one here would fold it.
    render(fence(`${lines(16)}\n`, 'go'))

    expect(screen.queryByRole('button', { name: /lines of/ })).not.toBeInTheDocument()
  })

  // The fallback that matters: anything other than the plain string
  // react-markdown normally provides must render untouched rather than fold a
  // block whose size could not be measured.
  it('renders untouched when the child is not a measurable code element', () => {
    render(
      <CollapsibleCodeBlock>
        <code>{[<span key="a">rendered</span>]}</code>
      </CollapsibleCodeBlock>,
    )

    expect(screen.getByText('rendered')).toBeInTheDocument()
    // Not merely "does not fold": with no readable source there is nothing to
    // copy either, so the whole header stays off rather than offering a button
    // that would silently yield ''.
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('preserves the data-block marker Streamdown sets on the fence', () => {
    const { container } = render(fence(lines(3), 'go'))

    expect(container.querySelector('code[data-block="true"]')).not.toBeNull()
  })
})

// ── the header chrome ────────────────────────────────────────────────────────
//
// Streamdown renders its own language label and its own copy/download pair;
// `globals.css` hides both inside this wrapper and these replace them. Two
// things are only reachable that way: the language as an ICON rather than a
// lowercase word, and a wrap toggle, which Streamdown has no equivalent of.
describe('CollapsibleCodeBlock — header chrome', () => {
  it('toggles line wrap on the block it belongs to', async () => {
    const { container } = render(fence(lines(4), 'bash'))
    const card = container.querySelector('.chat-code')

    expect(card).toHaveAttribute('data-wrap', 'false')
    const toggle = screen.getByRole('button', { name: 'Wrap lines' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    await userEvent.click(toggle)
    expect(card).toHaveAttribute('data-wrap', 'true')
    // The label follows the state, so the control says what it will do next
    // rather than what it did.
    expect(screen.getByRole('button', { name: 'Disable line wrap' })).toHaveAttribute('aria-pressed', 'true')
  })

  // Per block, not per app: a wrapped long line is unreadable as a COMMAND,
  // and a scrolled one hides its own tail, so neither default suits every
  // fence and the choice must not leak between them.
  it('keeps wrap state independent between two blocks', async () => {
    const { container } = render(
      <>
        {fence(lines(4), 'bash')}
        {fence(lines(5), 'go')}
      </>,
    )
    const [first, second] = Array.from(container.querySelectorAll('.chat-code'))

    await userEvent.click(screen.getAllByRole('button', { name: 'Wrap lines' })[0])
    expect(first).toHaveAttribute('data-wrap', 'true')
    expect(second).toHaveAttribute('data-wrap', 'false')
  })

  it('copies the fence source verbatim and acknowledges it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(fence('echo hi\necho bye', 'bash'))

    await userEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(writeText).toHaveBeenCalledWith('echo hi\necho bye')
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
    vi.unstubAllGlobals()
  })

  // The language reaches the header as an icon, so the only assertion left is
  // that the fence's declared language is what picks it.
  it('names the icon after the fence’s language', () => {
    const { container } = render(fence(lines(4), 'bash'))
    expect(container.querySelector('.chat-code')).toHaveAttribute('data-language', 'bash')
  })

  it('still renders a header for a fence opened with no language', () => {
    const { container } = render(fence(lines(4)))
    expect(container.querySelector('.chat-code')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
  })
})

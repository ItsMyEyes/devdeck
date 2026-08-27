import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { InlineCodeText, splitInlineCode } from '@/features/agent-chat/InlineCodeText'

afterEach(() => cleanup())

describe('splitInlineCode', () => {
  it('alternates plain and code, plain first', () => {
    expect(splitInlineCode('kondisi `Source.IsManually()` di titik ini')).toEqual([
      'kondisi ',
      'Source.IsManually()',
      ' di titik ini',
    ])
  })

  it('leaves text with no backticks as one segment', () => {
    expect(splitInlineCode('plain sentence')).toEqual(['plain sentence'])
  })

  // An unclosed span must not swallow the rest of the sentence into code.
  it('folds an unpaired trailing backtick back into the plain text', () => {
    expect(splitInlineCode('a `b` c `d')).toEqual(['a ', 'b', ' c `d'])
  })

  it('handles a string that is nothing but one code span', () => {
    expect(splitInlineCode('`gofmt`')).toEqual(['', 'gofmt', ''])
  })
})

describe('InlineCodeText', () => {
  it('renders the backticked run as a code element and the rest as text', () => {
    render(<InlineCodeText text="ganti ke `IsSemiAutomate()` saja" />)

    const code = screen.getByText('IsSemiAutomate()')
    expect(code.tagName).toBe('CODE')
    expect(code.parentElement?.textContent).toBe('ganti ke IsSemiAutomate() saja')
  })

  it('renders no markup at all for plain text', () => {
    const { container } = render(<InlineCodeText text="apa adanya" />)

    expect(container.querySelector('code')).toBeNull()
    expect(container.textContent).toBe('apa adanya')
  })

  // Markdown that is NOT inline code stays literal on purpose — a question is
  // one sentence in a fixed card, not a document.
  it('leaves other markdown alone', () => {
    const { container } = render(<InlineCodeText text="**bold** and # heading" />)

    expect(container.textContent).toBe('**bold** and # heading')
  })
})

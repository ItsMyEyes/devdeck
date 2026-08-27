import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ComposerPendingUserInputPanel } from '@/features/agent-chat/ComposerPendingUserInputPanel'
import type { PendingUserInput } from '@/features/agent-chat/types'

afterEach(() => cleanup())

const twoQuestionPrompt: PendingUserInput = {
  requestId: 'req-1', createdAt: 1,
  questions: [
    { id: 'q1', header: 'Style', question: 'Tabs or spaces?', multiSelect: false,
      options: [{ label: 'Tabs', description: '' }, { label: 'Spaces', description: '' }] },
    { id: 'q2', header: 'More', question: 'Semicolons?', multiSelect: false,
      options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }] },
  ],
}

function renderPanel(overrides: Partial<Parameters<typeof ComposerPendingUserInputPanel>[0]> = {}) {
  const onToggleOption = vi.fn()
  const onAdvance = vi.fn()
  render(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[twoQuestionPrompt]}
      answers={{}}
      questionIndex={0}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      {...overrides}
    />,
  )
  return { onToggleOption, onAdvance }
}

describe('ComposerPendingUserInputPanel', () => {
  it('renders nothing when there is no pending request', () => {
    const { container } = render(
      <ComposerPendingUserInputPanel pendingUserInputs={[]} answers={{}} questionIndex={0} onToggleOption={vi.fn()} onAdvance={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('digit 3 does nothing (only two options exist) but digit 1 selects the first option', () => {
    const { onToggleOption } = renderPanel()
    fireEvent.keyDown(document, { key: '3' })
    expect(onToggleOption).not.toHaveBeenCalled()
    fireEvent.keyDown(document, { key: '1' })
    expect(onToggleOption).toHaveBeenCalledWith('q1', 'Tabs')
  })

  it('digit shortcut does nothing when focus is inside a text input', () => {
    render(
      <div>
        <input data-testid="editor" />
        <ComposerPendingUserInputPanel pendingUserInputs={[twoQuestionPrompt]} answers={{}} questionIndex={0} onToggleOption={vi.fn()} onAdvance={vi.fn()} />
      </div>,
    )
    const onToggleOption = vi.fn()
    screen.getByTestId('editor').focus()
    fireEvent.keyDown(screen.getByTestId('editor'), { key: '1' })
    expect(onToggleOption).not.toHaveBeenCalled()
  })

  it('single-select auto-advances 200ms after a click', async () => {
    vi.useFakeTimers()
    const { onAdvance } = renderPanel()
    fireEvent.click(screen.getByText('Tabs'))
    vi.advanceTimersByTime(200)
    expect(onAdvance).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('multi-select does NOT auto-advance', async () => {
    vi.useFakeTimers()
    const multi: PendingUserInput = { ...twoQuestionPrompt, questions: [{ ...twoQuestionPrompt.questions[0], multiSelect: true }] }
    const onAdvance = vi.fn()
    render(<ComposerPendingUserInputPanel pendingUserInputs={[multi]} answers={{}} questionIndex={0} onToggleOption={vi.fn()} onAdvance={onAdvance} />)
    fireEvent.click(screen.getByText('Tabs'))
    vi.advanceTimersByTime(500)
    expect(onAdvance).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('shows an n/m counter only when there is more than one question', () => {
    renderPanel()
    expect(screen.getByText('1/2')).toBeInTheDocument()
  })

  it('the selected option shows a check icon, not its kbd hint', () => {
    renderPanel({ answers: { q1: { selectedOptionLabels: ['Tabs'] } } })
    expect(screen.queryByText('1')).not.toBeInTheDocument()
  })

  // ── The multi-select dead end ──
  //
  // A multi-select prompt never auto-advances (correct — the operator is still
  // picking), and the panel had no confirm control of any kind, so `onAdvance`
  // was unreachable and the thread parked on a card that could not be answered.
  describe('multi-select confirm', () => {
    const multi: PendingUserInput = {
      requestId: 'req-2', createdAt: 1,
      questions: [{
        id: 'q1', header: 'Scope', question: 'Which files?', multiSelect: true,
        options: [{ label: 'Tabs', description: '' }, { label: 'Spaces', description: '' }],
      }],
    }

    function renderMulti(answers: Parameters<typeof ComposerPendingUserInputPanel>[0]['answers'] = {}) {
      const onAdvance = vi.fn()
      render(
        <ComposerPendingUserInputPanel
          pendingUserInputs={[multi]}
          answers={answers}
          questionIndex={0}
          onToggleOption={vi.fn()}
          onAdvance={onAdvance}
        />,
      )
      return { onAdvance }
    }

    it('is disabled while nothing is selected', () => {
      renderMulti()
      expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled()
    })

    it('submits the selection once one is made', () => {
      const { onAdvance } = renderMulti({ q1: { selectedOptionLabels: ['Tabs'] } })
      const confirm = screen.getByRole('button', { name: 'Send answer' })
      expect(confirm).toBeEnabled()
      fireEvent.click(confirm)
      expect(onAdvance).toHaveBeenCalledTimes(1)
    })

    it('counts the selection in the hint', () => {
      renderMulti({ q1: { selectedOptionLabels: ['Tabs', 'Spaces'] } })
      expect(screen.getByText('2 selected · press 1–2 to toggle')).toBeInTheDocument()
    })

    // Single-select advances on click, so a confirm there would be a second way
    // to do what has already happened.
    it('is absent on a single-select question', () => {
      renderPanel()
      expect(screen.queryByRole('button', { name: /Send answer|Next question/ })).not.toBeInTheDocument()
    })
  })

  // A multi-question prompt used to erase question 1 the moment it advanced, so
  // by the last question the operator could not see what they had already
  // committed the turn to.
  it('keeps the answers to earlier questions on screen', () => {
    renderPanel({ questionIndex: 1, answers: { q1: { selectedOptionLabels: ['Tabs'] } } })
    expect(screen.getByText('Semicolons?')).toBeInTheDocument()
    expect(screen.getByText('Style ·')).toBeInTheDocument()
    expect(screen.getByText(/Tabs/)).toBeInTheDocument()
    expect(screen.getByText('2/2')).toBeInTheDocument()
  })
})

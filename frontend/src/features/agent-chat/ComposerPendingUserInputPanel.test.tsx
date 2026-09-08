import { useState } from 'react'
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

/** The one-question prompt: the only shape that still advances on click. */
const singleQuestionPrompt: PendingUserInput = {
  requestId: 'req-solo', createdAt: 1,
  questions: [twoQuestionPrompt.questions[0]],
}

function renderPanel(overrides: Partial<Parameters<typeof ComposerPendingUserInputPanel>[0]> = {}) {
  const onToggleOption = vi.fn()
  const onAdvance = vi.fn()
  const onBack = vi.fn()
  render(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[twoQuestionPrompt]}
      answers={{}}
      questionIndex={0}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
      onBack={onBack}
      {...overrides}
    />,
  )
  return { onToggleOption, onAdvance, onBack }
}

describe('ComposerPendingUserInputPanel', () => {
  it('renders nothing when there is no pending request', () => {
    const { container } = render(
      <ComposerPendingUserInputPanel pendingUserInputs={[]} answers={{}} questionIndex={0} onToggleOption={vi.fn()} onAdvance={vi.fn()} onBack={vi.fn()} />,
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
        <ComposerPendingUserInputPanel pendingUserInputs={[twoQuestionPrompt]} answers={{}} questionIndex={0} onToggleOption={vi.fn()} onAdvance={vi.fn()} onBack={vi.fn()} />
      </div>,
    )
    const onToggleOption = vi.fn()
    screen.getByTestId('editor').focus()
    fireEvent.keyDown(screen.getByTestId('editor'), { key: '1' })
    expect(onToggleOption).not.toHaveBeenCalled()
  })

  it('a lone single-select question auto-advances 200ms after a click', async () => {
    vi.useFakeTimers()
    const { onAdvance } = renderPanel({ pendingUserInputs: [singleQuestionPrompt] })
    fireEvent.click(screen.getByText('Tabs'))
    vi.advanceTimersByTime(200)
    expect(onAdvance).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('multi-select does NOT auto-advance', async () => {
    vi.useFakeTimers()
    const multi: PendingUserInput = { ...twoQuestionPrompt, questions: [{ ...twoQuestionPrompt.questions[0], multiSelect: true }] }
    const onAdvance = vi.fn()
    render(<ComposerPendingUserInputPanel pendingUserInputs={[multi]} answers={{}} questionIndex={0} onToggleOption={vi.fn()} onAdvance={onAdvance} onBack={vi.fn()} />)
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
          onBack={vi.fn()}
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

    // A LONE single-select question advances on click, so a confirm there would
    // be a second way to do what has already happened. (A stacked one does need
    // it — see the stepper suite below.)
    it('is absent on a lone single-select question', () => {
      renderPanel({ pendingUserInputs: [singleQuestionPrompt] })
      expect(screen.queryByRole('button', { name: /Send answer|Next question/ })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
    })
  })

  // ── The stacked stepper ──
  //
  // A multi-question prompt used to be one-way and partly automatic: a
  // single-select pick advanced itself after 200ms and a pick on the LAST
  // question submitted the turn outright, with no control anywhere that went
  // back. Every question in a stack is now stepped by hand.
  describe('stacked prompt stepper', () => {
    it('does not auto-advance a single-select question', () => {
      vi.useFakeTimers()
      const { onAdvance } = renderPanel()
      fireEvent.click(screen.getByText('Tabs'))
      vi.advanceTimersByTime(1000)
      expect(onAdvance).not.toHaveBeenCalled()
      vi.useRealTimers()
    })

    it('offers Next on a single-select question, disabled until one is picked', () => {
      renderPanel()
      expect(screen.getByRole('button', { name: /Next question/ })).toBeDisabled()
      cleanup()
      const { onAdvance } = renderPanel({ answers: { q1: { selectedOptionLabels: ['Tabs'] } } })
      const next = screen.getByRole('button', { name: /Next question/ })
      expect(next).toBeEnabled()
      fireEvent.click(next)
      expect(onAdvance).toHaveBeenCalledTimes(1)
    })

    it('commits through Send answer on the last question rather than on the pick', () => {
      const { onAdvance } = renderPanel({ questionIndex: 1, answers: { q1: { selectedOptionLabels: ['Tabs'] } } })
      expect(screen.queryByRole('button', { name: /Next question/ })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled()
      fireEvent.click(screen.getByText('Yes'))
      expect(onAdvance).not.toHaveBeenCalled()
    })

    it('has no Back on the first question and one on every question after it', () => {
      renderPanel()
      expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument()
      cleanup()
      const { onBack } = renderPanel({ questionIndex: 1 })
      fireEvent.click(screen.getByRole('button', { name: 'Back' }))
      expect(onBack).toHaveBeenCalledTimes(1)
    })

    it('steps with ←/→, under the same guards as the buttons', () => {
      const { onAdvance, onBack } = renderPanel({ questionIndex: 1, answers: { q1: { selectedOptionLabels: ['Tabs'] } } })
      // q2 is unanswered, so → is refused exactly as Send answer is disabled.
      fireEvent.keyDown(document, { key: 'ArrowRight' })
      expect(onAdvance).not.toHaveBeenCalled()
      fireEvent.keyDown(document, { key: 'ArrowLeft' })
      expect(onBack).toHaveBeenCalledTimes(1)
    })

    // ── The stale-closure regression ──
    //
    // Every test above renders the panel ONCE at a fixed `questionIndex`, which
    // is exactly the case a stale keydown listener still gets right. Driving
    // the index through real state is what caught it: ← consulted the index it
    // had captured on the first render — always 0 — so after stepping forward
    // it refused to step back, while the Back button beside it worked.
    it('still steps back after the index has moved through state', () => {
      function Host() {
        const [index, setIndex] = useState(0)
        return (
          <ComposerPendingUserInputPanel
            pendingUserInputs={[twoQuestionPrompt]}
            answers={{ q1: { selectedOptionLabels: ['Tabs'] } }}
            questionIndex={index}
            onToggleOption={vi.fn()}
            onAdvance={() => setIndex((i) => i + 1)}
            onBack={() => setIndex((i) => Math.max(0, i - 1))}
          />
        )
      }
      render(<Host />)
      fireEvent.click(screen.getByRole('button', { name: /Next question/ }))
      expect(screen.getByText('2/2')).toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'ArrowLeft' })
      expect(screen.getByText('1/2')).toBeInTheDocument()
      fireEvent.keyDown(document, { key: 'ArrowRight' })
      expect(screen.getByText('2/2')).toBeInTheDocument()
    })

    it('ignores ←/→ on a lone question, which has nowhere to step', () => {
      const { onAdvance, onBack } = renderPanel({
        pendingUserInputs: [singleQuestionPrompt],
        answers: { q1: { selectedOptionLabels: ['Tabs'] } },
      })
      fireEvent.keyDown(document, { key: 'ArrowRight' })
      fireEvent.keyDown(document, { key: 'ArrowLeft' })
      expect(onAdvance).not.toHaveBeenCalled()
      expect(onBack).not.toHaveBeenCalled()
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

import { describe, expect, it } from 'vitest'
import {
  buildPendingUserInputAnswers,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from '@/features/agent-chat/pendingUserInput'
import type { PendingUserInputDraftAnswer, UserInputQuestion } from '@/features/agent-chat/pendingUserInput'

const singleSelect: UserInputQuestion = {
  id: 'Tabs or spaces?', header: 'Style', question: 'Tabs or spaces?',
  options: [{ label: 'Tabs', description: '' }, { label: 'Spaces', description: '' }],
  multiSelect: false,
}
const multiSelect: UserInputQuestion = { ...singleSelect, id: 'Which files?', multiSelect: true }

describe('resolvePendingUserInputAnswer', () => {
  it('a non-empty custom answer beats any selected option', () => {
    const draft: PendingUserInputDraftAnswer = { customAnswer: 'Both, actually', selectedOptionLabels: ['Tabs'] }
    expect(resolvePendingUserInputAnswer(singleSelect, draft)).toBe('Both, actually')
  })
  it('single-select returns the first selected label', () => {
    expect(resolvePendingUserInputAnswer(singleSelect, { selectedOptionLabels: ['Tabs'] })).toBe('Tabs')
  })
  it('multi-select returns the array, or null if empty', () => {
    expect(resolvePendingUserInputAnswer(multiSelect, { selectedOptionLabels: ['Tabs', 'Spaces'] })).toEqual(['Tabs', 'Spaces'])
    expect(resolvePendingUserInputAnswer(multiSelect, { selectedOptionLabels: [] })).toBeNull()
  })
  it('no draft at all is null', () => {
    expect(resolvePendingUserInputAnswer(singleSelect, undefined)).toBeNull()
  })
})

describe('togglePendingUserInputOptionSelection', () => {
  it('multiSelect: toggling twice is idempotent (back to empty)', () => {
    let draft = togglePendingUserInputOptionSelection(multiSelect, undefined, 'Tabs')
    draft = togglePendingUserInputOptionSelection(multiSelect, draft, 'Tabs')
    expect(resolvePendingUserInputAnswer(multiSelect, draft)).toBeNull()
  })
  it('single-select: picking a second option replaces the first, clears customAnswer', () => {
    let draft = togglePendingUserInputOptionSelection(singleSelect, undefined, 'Tabs')
    draft = togglePendingUserInputOptionSelection(singleSelect, draft, 'Spaces')
    expect(resolvePendingUserInputAnswer(singleSelect, draft)).toBe('Spaces')
  })
})

describe('countAnsweredPendingUserInputQuestions', () => {
  it('counts only answered questions', () => {
    const count = countAnsweredPendingUserInputQuestions([singleSelect, multiSelect], {
      [singleSelect.id]: { selectedOptionLabels: ['Tabs'] },
    })
    expect(count).toBe(1)
  })
})

describe('buildPendingUserInputAnswers', () => {
  it('returns null while any question is unanswered', () => {
    const answers = buildPendingUserInputAnswers([singleSelect, multiSelect], {
      [singleSelect.id]: { selectedOptionLabels: ['Tabs'] },
    })
    expect(answers).toBeNull()
  })
  it('returns the full map once every question is answered', () => {
    const answers = buildPendingUserInputAnswers([singleSelect, multiSelect], {
      [singleSelect.id]: { selectedOptionLabels: ['Tabs'] },
      [multiSelect.id]: { selectedOptionLabels: ['Spaces'] },
    })
    expect(answers).toEqual({ [singleSelect.id]: 'Tabs', [multiSelect.id]: ['Spaces'] })
  })
})

describe('findFirstUnansweredPendingUserInputQuestionIndex', () => {
  it('clamps to the last index when every question is answered', () => {
    const idx = findFirstUnansweredPendingUserInputQuestionIndex([singleSelect], {
      [singleSelect.id]: { selectedOptionLabels: ['Tabs'] },
    })
    expect(idx).toBe(0)
  })
})

describe('derivePendingUserInputProgress', () => {
  it('reports isLastQuestion and isComplete independently', () => {
    const progress = derivePendingUserInputProgress([singleSelect, multiSelect], {
      [singleSelect.id]: { selectedOptionLabels: ['Tabs'] },
    }, 0)
    expect(progress.isLastQuestion).toBe(false)
    expect(progress.isComplete).toBe(false)
    expect(progress.canAdvance).toBe(true)
  })
})

describe('setPendingUserInputCustomAnswer', () => {
  it('a non-empty custom answer clears any selected options', () => {
    const draft = setPendingUserInputCustomAnswer({ selectedOptionLabels: ['Tabs'] }, 'Both please')
    expect(draft.selectedOptionLabels).toBeUndefined()
    expect(draft.customAnswer).toBe('Both please')
  })
})

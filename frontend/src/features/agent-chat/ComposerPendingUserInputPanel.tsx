// Renders the composer's queue-of-one `AskUserQuestion` prompt. Ported from
// t3code's `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx`,
// with deliberate deviations (see plan T7 / spec §1.7):
//  - `respondingRequestIds`/`isResponding` are dropped: A1 has no separate
//    "in flight" prop, the double-submit case is a server-side no-op.
//  - This repo's semantic tokens are used instead of t3code's raw values.
//  - Focus moves to the first option button whenever a fresh prompt opens
//    (new behavior, not in t3code) — the digit-shortcut listener otherwise
//    keeps t3code's exact bail conditions verbatim.
import { memo, useEffect, useEffectEvent, useRef, useState } from 'react'
import { CheckIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from '@/features/agent-chat/pendingUserInput'
import type { PendingUserInput } from '@/features/agent-chat/types'

export interface ComposerPendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[]
  answers: Record<string, PendingUserInputDraftAnswer>
  questionIndex: number
  onToggleOption: (questionId: string, optionLabel: string) => void
  onAdvance: () => void
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
}: ComposerPendingUserInputPanelProps) {
  const activePrompt = pendingUserInputs[0]
  if (!activePrompt) return null

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      onAdvance={onAdvance}
    />
  )
})

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  answers,
  questionIndex,
  onToggleOption,
  onAdvance,
}: {
  prompt: PendingUserInput
  answers: Record<string, PendingUserInputDraftAnswer>
  questionIndex: number
  onToggleOption: (questionId: string, optionLabel: string) => void
  onAdvance: () => void
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex)
  const activeQuestion = progress.activeQuestion
  const autoAdvanceTimerRef = useRef<number | null>(null)
  const onAdvanceRef = useRef(onAdvance)
  const firstOptionRef = useRef<HTMLButtonElement | null>(null)
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string
    optionLabel: string
  } | null>(null)

  useEffect(() => {
    onAdvanceRef.current = onAdvance
  }, [onAdvance])

  useEffect(() => {
    if (!activeQuestion || activeQuestion.multiSelect || !optimisticSingleSelect) {
      return
    }
    if (optimisticSingleSelect.questionId !== activeQuestion.id) {
      setOptimisticSingleSelect(null)
      return
    }
    if (
      progress.customAnswer.trim().length === 0 &&
      progress.selectedOptionLabels.includes(optimisticSingleSelect.optionLabel)
    ) {
      setOptimisticSingleSelect(null)
    }
  }, [activeQuestion, optimisticSingleSelect, progress.customAnswer, progress.selectedOptionLabels])

  // Clear auto-advance timer on unmount.
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current)
      }
    }
  }, [])

  // Focus-on-open (spec §1.7): a fresh prompt takes focus so the operator's
  // next keystroke belongs to the panel.
  useEffect(() => {
    if (activeQuestion) firstOptionRef.current?.focus()
  }, [prompt.requestId])

  const handleOptionSelection = useEffectEvent((questionId: string, optionLabel: string) => {
    if (activeQuestion?.multiSelect) {
      onToggleOption(questionId, optionLabel)
      return
    }
    setOptimisticSingleSelect({ questionId, optionLabel })
    onToggleOption(questionId, optionLabel)
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current)
    }
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null
      onAdvanceRef.current()
    }, 200)
  })

  // Keyboard shortcut: number keys 1-9 select corresponding options when
  // focus is outside editable fields. Multi-select prompts toggle options in
  // place; single-select prompts keep the auto-advance behavior above.
  useEffect(() => {
    if (!activeQuestion) return
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return
      }
      const digit = Number.parseInt(event.key, 10)
      if (Number.isNaN(digit) || digit < 1 || digit > 9) return
      const optionIndex = digit - 1
      if (optionIndex >= activeQuestion.options.length) return
      const option = activeQuestion.options[optionIndex]
      if (!option) return
      event.preventDefault()
      handleOptionSelection(activeQuestion.id, option.label)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [activeQuestion])

  if (!activeQuestion) {
    return null
  }

  const customAnswerActive = progress.customAnswer.trim().length > 0

  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="mb-2 flex items-center gap-3">
        <span className="text-muted-foreground text-[11px] font-semibold tracking-widest uppercase">
          {activeQuestion.header}
        </span>
        {prompt.questions.length > 1 ? (
          <span className="flex h-5 items-center rounded-md bg-muted px-1.5 text-muted-foreground text-[10px] font-medium tabular-nums">
            {questionIndex + 1}/{prompt.questions.length}
          </span>
        ) : null}
      </div>
      <p className="text-sm text-foreground">{activeQuestion.question}</p>
      {activeQuestion.multiSelect ? (
        <p className="mt-1 text-muted-foreground text-xs">Select one or more options.</p>
      ) : null}
      <div className="mt-3 space-y-1.5">
        {activeQuestion.options.map((option, index) => {
          const isOptimisticallySelected =
            optimisticSingleSelect?.questionId === activeQuestion.id &&
            optimisticSingleSelect.optionLabel === option.label
          const isSelected =
            isOptimisticallySelected ||
            (!customAnswerActive && progress.selectedOptionLabels.includes(option.label))
          const shortcutKey = index < 9 ? index + 1 : null
          const className = cn(
            'group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-all duration-150 cursor-pointer focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/25',
            isSelected
              ? 'border-primary/30 bg-primary/8 text-foreground'
              : 'border-transparent bg-muted/40 text-foreground/85 hover:border-border/45 hover:bg-muted/60',
          )
          const content = (
            <>
              <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                <span className="text-sm font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="text-muted-foreground text-xs">{option.description}</span>
                ) : null}
              </div>
              {isSelected ? (
                <CheckIcon className="size-3.5 shrink-0 text-primary" />
              ) : shortcutKey !== null ? (
                <kbd
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded border border-border/50 text-[11px] font-medium tabular-nums transition-colors duration-150',
                    'bg-background/35 text-muted-foreground group-hover:border-border/70 group-hover:text-foreground',
                  )}
                >
                  {shortcutKey}
                </kbd>
              ) : null}
            </>
          )
          return (
            <button
              key={`${activeQuestion.id}:${option.label}`}
              type="button"
              ref={index === 0 ? firstOptionRef : undefined}
              onClick={() => {
                handleOptionSelection(activeQuestion.id, option.label)
              }}
              className={className}
            >
              {content}
            </button>
          )
        })}
      </div>
    </div>
  )
})

// Renders the composer's queue-of-one `AskUserQuestion` prompt. Ported from
// t3code's `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx`,
// with deliberate deviations (see plan T7 / spec §1.7):
//  - `respondingRequestIds`/`isResponding` are dropped: A1 has no separate
//    "in flight" prop, the double-submit case is a server-side no-op.
//  - Focus moves to the first option button whenever a fresh prompt opens
//    (new behavior, not in t3code) — the digit-shortcut listener otherwise
//    keeps t3code's exact bail conditions verbatim.
//
// ── The 2026-08 redesign ──
// The port carried t3code's shadcn tokens (`bg-muted/40`, `border-primary/8`,
// `text-foreground/85`) rather than DevDeck's, and it showed. Three problems,
// all of them the same problem — nothing on the card had an edge:
//
//  1. The card had no container at all: padding on the composer surface, so a
//     question the agent was BLOCKED on read as loose text above the caret.
//  2. The options were `border-transparent bg-muted/40` — a 4% wash on the
//     composer's own fill. They did not look clickable, which is the one thing
//     they had to look like.
//  3. The shortcut digit sat at the FAR RIGHT of each row, hundreds of pixels
//     from the label it belonged to, so the card read as a list of statements
//     with a stray number column. It is now the row's leading slot: the same
//     14px-glyph-then-label shell the transcript's work log uses, which is
//     also what makes the selected row swap the digit for a check without the
//     text moving.
//
// Everything below is DESIGN.md's own vocabulary: `--devdeck-on` for the
// selected wash, the accent for the check (its "selection" job), one tone step
// per layer (composer `raised` → card `card` → option `raised`), and radii off
// the three-step scale.
import { memo, useEffect, useEffectEvent, useRef, useState } from 'react'
import { CheckIcon, CircleQuestionMark } from 'lucide-react'
import { cn } from '@/lib/utils'
import { InlineCodeText } from '@/features/agent-chat/InlineCodeText'
import {
  derivePendingUserInputProgress,
  resolvePendingUserInputAnswer,
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

/** How long the selected row stays on screen before a single-select prompt
 *  advances itself. Kept at t3code's 200ms: it is the smallest delay that still
 *  paints the check, and the answer is recorded in the transcript the moment
 *  the card closes (see `answeredQuestionsOf` in `eventReducer.ts`), so the
 *  card no longer has to be the only place the pick was ever visible. */
const AUTO_ADVANCE_MS = 200

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

/** The leading 14px slot every option row opens with — the digit that picks it,
 *  or the check that says it is picked. One fixed-size slot for both, so
 *  selecting an option cannot shift its own label sideways. */
function OptionMarker({ selected, shortcutKey }: { selected: boolean; shortcutKey: number | null }) {
  if (selected) {
    return (
      <span className="flex size-5 flex-none items-center justify-center text-devdeck-accent">
        <CheckIcon className="size-3.5" aria-hidden="true" />
      </span>
    )
  }
  if (shortcutKey === null) return <span className="size-5 flex-none" aria-hidden="true" />
  return (
    <kbd
      aria-hidden="true"
      className={cn(
        'flex size-5 flex-none items-center justify-center rounded-micro border border-devdeck-hairline',
        'bg-devdeck-card font-mono text-[11px] leading-none tabular-nums text-devdeck-dim-pane',
        'transition-colors group-hover:border-devdeck-line/60 group-hover:text-devdeck-fg-2',
      )}
    >
      {shortcutKey}
    </kbd>
  )
}

/** A question this prompt has already been answered — `✓ Style · Tabs`.
 *
 *  A multi-question prompt used to erase question 1 the instant it advanced to
 *  question 2, so by the last question the operator could no longer see what
 *  they had already committed the turn to. These rows are that history, and
 *  they are dim and 11.5px because they are context for the question below
 *  them, not the decision in front of you. */
function AnsweredTrailRow({ header, answer }: { header: string; answer: string }) {
  return (
    <div className="flex items-start gap-1.5 text-[11.5px] leading-snug text-devdeck-fg-2">
      <CheckIcon className="mt-[3px] size-3 flex-none text-devdeck-accent" aria-hidden="true" />
      <span className="min-w-0">
        <span className="text-devdeck-dim-pane">{header} · </span>
        <InlineCodeText text={answer} />
      </span>
    </div>
  )
}

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
    }, AUTO_ADVANCE_MS)
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
  // Every question BEFORE the one on screen, with the answer it was given —
  // see `AnsweredTrailRow`. Read through `resolvePendingUserInputAnswer` so a
  // free-text answer and a picked option land in the same shape.
  const answeredTrail = prompt.questions.slice(0, progress.questionIndex).flatMap((question) => {
    const answer = resolvePendingUserInputAnswer(question, answers[question.id])
    if (answer === null) return []
    return [{ id: question.id, header: question.header, answer: Array.isArray(answer) ? answer.join(', ') : answer }]
  })
  // The multi-select confirm. Single-select advances itself on click, so a
  // button there would be a second way to do what already happened; a
  // multi-select prompt had NO way to advance at all before this — the panel
  // only ever toggled options and `onAdvance` was unreachable, so a prompt with
  // `multiSelect: true` parked the thread on a card that could not be answered.
  const showConfirm = activeQuestion.multiSelect
  const selectedCount = customAnswerActive ? 0 : progress.selectedOptionLabels.length

  return (
    <div
      // A real card, on the tone step above the composer's own fill: this is
      // the thread waiting on the operator, and it has to read as a thing with
      // an edge rather than as text that happens to be up there.
      className="rounded-container border border-devdeck-border-card bg-devdeck-card px-3.5 py-3"
    >
      <div className="flex items-center gap-2">
        {/* The one accent mark on the card, on DESIGN.md's "state" job: it
            says the turn is parked here. */}
        <CircleQuestionMark className="size-3.5 flex-none text-devdeck-accent" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold tracking-[0.13em] uppercase text-devdeck-fg-2">
          {activeQuestion.header}
        </span>
        {prompt.questions.length > 1 ? (
          <span className="flex-none rounded-micro bg-devdeck-raised px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-devdeck-fg-2">
            {questionIndex + 1}/{prompt.questions.length}
          </span>
        ) : null}
      </div>

      {answeredTrail.length > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          {answeredTrail.map((entry) => (
            <AnsweredTrailRow key={entry.id} header={entry.header} answer={entry.answer} />
          ))}
        </div>
      ) : null}

      {/* The question is the loudest thing on the card — 13.5px on `--fg`,
          against the 10.5px eyebrow above it and the 12.5px option
          descriptions below. It was the same 14px/`text-sm` as the option
          labels, which is what left the card with no focal point. */}
      <p className="mt-1.5 text-[13.5px] leading-snug font-medium text-devdeck-fg">
        <InlineCodeText text={activeQuestion.question} />
      </p>

      <div className="mt-2.5 flex flex-col gap-1">
        {activeQuestion.options.map((option, index) => {
          const isOptimisticallySelected =
            optimisticSingleSelect?.questionId === activeQuestion.id &&
            optimisticSingleSelect.optionLabel === option.label
          const isSelected =
            isOptimisticallySelected ||
            (!customAnswerActive && progress.selectedOptionLabels.includes(option.label))
          const shortcutKey = index < 9 ? index + 1 : null
          return (
            <button
              key={`${activeQuestion.id}:${option.label}`}
              type="button"
              aria-pressed={isSelected}
              ref={index === 0 ? firstOptionRef : undefined}
              onClick={() => {
                handleOptionSelection(activeQuestion.id, option.label)
              }}
              className={cn(
                'group flex w-full cursor-pointer items-start gap-2.5 rounded-control border px-2.5 py-2 text-left',
                'outline-none transition-colors focus-visible:border-devdeck-border-accent focus-visible:ring-1 focus-visible:ring-devdeck-ring',
                isSelected
                  ? // DESIGN.md's selected state: the white wash, with the
                    // accent check (8.10:1 in the pane) carrying the contrast
                    // the 1.86:1 wash cannot carry on its own.
                    'border-devdeck-border-menu bg-devdeck-on text-devdeck-fg'
                  : 'border-devdeck-hairline bg-devdeck-raised text-devdeck-fg hover:border-devdeck-line/50 hover:bg-devdeck-card',
              )}
            >
              <span className="mt-px flex-none">
                <OptionMarker selected={isSelected} shortcutKey={shortcutKey} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[13px] leading-snug font-medium">
                  <InlineCodeText text={option.label} />
                </span>
                {option.description && option.description !== option.label ? (
                  <span className="text-[12px] leading-snug text-devdeck-fg-2">
                    <InlineCodeText text={option.description} />
                  </span>
                ) : null}
              </span>
            </button>
          )
        })}
      </div>

      {/* One footer line: what the keyboard does on the left, the confirm on
          the right. Both are 11.5px `--fg-2` chrome — the decision is the
          options, and the hint must not compete with them. */}
      <div className="mt-2.5 flex items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-devdeck-dim-pane">
          {activeQuestion.multiSelect
            ? selectedCount > 0
              ? `${selectedCount} selected · press 1–${Math.min(activeQuestion.options.length, 9)} to toggle`
              : `Select one or more · press 1–${Math.min(activeQuestion.options.length, 9)} to toggle`
            : `Press 1–${Math.min(activeQuestion.options.length, 9)} to choose`}
        </span>
        {showConfirm ? (
          <button
            type="button"
            disabled={!progress.canAdvance}
            onClick={onAdvance}
            className={cn(
              'flex-none cursor-pointer rounded-control bg-devdeck-accent px-2.5 py-1 text-[12px] font-medium text-devdeck-accent-ink',
              'transition-colors hover:bg-devdeck-accent-hover',
              'disabled:cursor-default disabled:bg-devdeck-accent/30 disabled:text-devdeck-fg-2',
            )}
          >
            {progress.isLastQuestion ? 'Send answer' : 'Next question'}
          </button>
        ) : null}
      </div>
    </div>
  )
})

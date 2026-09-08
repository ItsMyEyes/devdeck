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
//
// ── The stepper ──
// One `AskUserQuestion` call can stack several questions of mixed kinds, and
// the card shows them one at a time. That stack used to be one-way and partly
// automatic: single-select advanced itself 200ms after a click, so an earlier
// question was gone before it could be re-read, and a click on the LAST one
// submitted the whole turn with no confirmation step at all. There was no
// control anywhere that went back.
//
// A stacked prompt is now stepped by hand — explicit Back/Next on every
// question, `Send answer` to commit, ←/→ as their keyboard twin — so each pick
// can be checked and any of them revisited. A prompt of ONE single-select
// question keeps the one-click fast path: it has nothing to step back to, and
// a Next button there would be a second way to do what the click already did.
import { memo, useEffect, useEffectEvent, useRef, useState } from 'react'
import { CheckIcon, ChevronLeft, ChevronRight, CircleQuestionMark } from 'lucide-react'
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
  /** Step back one question. Only reachable on a stacked (multi-question)
   *  prompt — see `isStacked` in the card below. */
  onBack: () => void
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
  onBack,
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
      onBack={onBack}
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
  onBack,
}: {
  prompt: PendingUserInput
  answers: Record<string, PendingUserInputDraftAnswer>
  questionIndex: number
  onToggleOption: (questionId: string, optionLabel: string) => void
  onAdvance: () => void
  onBack: () => void
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex)
  const activeQuestion = progress.activeQuestion
  // ── Stacked prompts step by hand ──
  //
  // One `AskUserQuestion` call can carry several questions, and the card shows
  // them one at a time. Single-select used to fire `onAdvance` itself 200ms
  // after a click, which on a stack meant question 1 was gone before it could
  // be re-read and the LAST question's click submitted the whole turn with no
  // confirmation — and nothing anywhere could return to an earlier answer.
  //
  // So a stack never navigates itself: every question gets an explicit
  // Back/Next pair, and the last one commits through `Send answer`. A lone
  // question keeps the one-click fast path (auto-advance below) — it has no
  // earlier question to step back to, and a Next button there would be a
  // second way to do what the click already did.
  const isStacked = prompt.questions.length > 1
  const autoAdvanceTimerRef = useRef<number | null>(null)
  const onAdvanceRef = useRef(onAdvance)
  const onBackRef = useRef(onBack)
  const firstOptionRef = useRef<HTMLButtonElement | null>(null)
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string
    optionLabel: string
  } | null>(null)

  useEffect(() => {
    onAdvanceRef.current = onAdvance
    onBackRef.current = onBack
  }, [onAdvance, onBack])

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

  function clearAutoAdvance() {
    if (autoAdvanceTimerRef.current !== null) {
      window.clearTimeout(autoAdvanceTimerRef.current)
      autoAdvanceTimerRef.current = null
    }
  }

  // Clear auto-advance timer on unmount.
  useEffect(() => {
    return () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current)
      }
    }
  }, [])

  // Focus-on-open (spec §1.7): a fresh prompt takes focus so the operator's
  // next keystroke belongs to the panel. Stepping to another question is the
  // same event — the card's whole body swapped, and the digit shortcuts have
  // to keep working without a trip back to the mouse.
  useEffect(() => {
    if (activeQuestion) firstOptionRef.current?.focus()
  }, [prompt.requestId, progress.questionIndex])

  const handleOptionSelection = useEffectEvent((questionId: string, optionLabel: string) => {
    // A stack is stepped by hand (see `isStacked`), so a pick here only
    // records the answer — Next is what moves the card.
    if (isStacked || activeQuestion?.multiSelect) {
      onToggleOption(questionId, optionLabel)
      return
    }
    setOptimisticSingleSelect({ questionId, optionLabel })
    onToggleOption(questionId, optionLabel)
    clearAutoAdvance()
    autoAdvanceTimerRef.current = window.setTimeout(() => {
      autoAdvanceTimerRef.current = null
      onAdvanceRef.current()
    }, AUTO_ADVANCE_MS)
  })

  // Both nav buttons cancel a pending auto-advance first: a lone question can
  // never reach them, but the timer must not be able to outlive the question
  // that armed it if that ever changes.
  const handleBack = useEffectEvent(() => {
    clearAutoAdvance()
    setOptimisticSingleSelect(null)
    onBackRef.current()
  })

  const handleAdvance = useEffectEvent(() => {
    clearAutoAdvance()
    setOptimisticSingleSelect(null)
    onAdvanceRef.current()
  })

  // Keyboard shortcut: number keys 1-9 select corresponding options when
  // focus is outside editable fields. Multi-select prompts toggle options in
  // place; single-select prompts keep the auto-advance behavior above. ←/→
  // mirror the Back/Next buttons under the same guards, so an arrow can never
  // step somewhere the button is disabled from stepping.
  //
  // The two step guards are read straight from `progress` and are therefore in
  // the dependency list, unlike the digit path's `handleOptionSelection`. An
  // Effect Event is what SHOULD have carried them, but the one this listener
  // would call reads its captured `progress` — not the current one — so a
  // stacked prompt's ← saw `questionIndex: 0` forever and refused to step,
  // while the button beside it worked. Rebuilding the listener is the version
  // that is actually correct; the two scalars only change on a pick or a step.
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
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        if (!isStacked) return
        const goingBack = event.key === 'ArrowLeft'
        if (goingBack ? progress.questionIndex === 0 : !progress.canAdvance) return
        event.preventDefault()
        if (goingBack) handleBack()
        else handleAdvance()
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
  }, [activeQuestion, isStacked, progress.questionIndex, progress.canAdvance])

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
  // The confirm. A multi-select prompt had NO way to advance at all before it
  // existed — the panel only ever toggled options and `onAdvance` was
  // unreachable, so a prompt with `multiSelect: true` parked the thread on a
  // card that could not be answered. A stacked prompt now needs one for the
  // same reason: it no longer advances itself (see `isStacked`). A lone
  // single-select question is the one case that still advances on click, so a
  // button there would be a second way to do what already happened.
  const showConfirm = isStacked || activeQuestion.multiSelect
  const showBack = isStacked && progress.questionIndex > 0
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

      {/* One footer line: what the keyboard does on the left, the stepper on
          the right. The hint is 11.5px `--fg-2` chrome — the decision is the
          options, and it must not compete with them. Back is the quiet half of
          the pair (it undoes; it is never the thing to do next), so it borrows
          the unselected option row's own treatment rather than the accent. */}
      <div className="mt-2.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-devdeck-dim-pane">
          {activeQuestion.multiSelect
            ? selectedCount > 0
              ? `${selectedCount} selected · press 1–${Math.min(activeQuestion.options.length, 9)} to toggle`
              : `Select one or more · press 1–${Math.min(activeQuestion.options.length, 9)} to toggle`
            : `Press 1–${Math.min(activeQuestion.options.length, 9)} to choose`}
          {/* The arrows are the buttons' keyboard twin and nothing else on the
              card announces them. Appended rather than substituted so the
              option hint stays the sentence that gets read first, and the
              truncate above drops this half — not that one — when the composer
              is narrow. */}
          {isStacked ? ' · ←/→ to step' : ''}
        </span>
        {showBack ? (
          <button
            type="button"
            onClick={handleBack}
            className={cn(
              'flex flex-none cursor-pointer items-center gap-1 rounded-control border border-devdeck-hairline',
              'bg-devdeck-raised py-1 pr-2.5 pl-1.5 text-[12px] font-medium text-devdeck-fg-2',
              'outline-none transition-colors hover:border-devdeck-line/50 hover:bg-devdeck-card hover:text-devdeck-fg',
              'focus-visible:border-devdeck-border-accent focus-visible:ring-1 focus-visible:ring-devdeck-ring',
            )}
          >
            <ChevronLeft className="size-3.5 flex-none" aria-hidden="true" />
            Back
          </button>
        ) : null}
        {showConfirm ? (
          <button
            type="button"
            disabled={!progress.canAdvance}
            onClick={handleAdvance}
            className={cn(
              'flex flex-none cursor-pointer items-center gap-1 rounded-control bg-devdeck-accent py-1 text-[12px] font-medium text-devdeck-accent-ink',
              progress.isLastQuestion ? 'px-2.5' : 'pr-1.5 pl-2.5',
              'outline-none transition-colors hover:bg-devdeck-accent-hover',
              'focus-visible:ring-1 focus-visible:ring-devdeck-ring',
              'disabled:cursor-default disabled:bg-devdeck-accent/30 disabled:text-devdeck-fg-2',
            )}
          >
            {progress.isLastQuestion ? (
              'Send answer'
            ) : (
              <>
                Next question
                <ChevronRight className="size-3.5 flex-none" aria-hidden="true" />
              </>
            )}
          </button>
        ) : null}
      </div>
    </div>
  )
})

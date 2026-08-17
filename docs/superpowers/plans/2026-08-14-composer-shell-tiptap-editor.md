# Plan — Composer Shell & TipTap Prompt Editor

Spec: `docs/superpowers/specs/2026-08-14-composer-shell-tiptap-editor-design.md`

Execution: TDD throughout. Tests are written before the implementation they
cover, and every task ends with its own tests green.

Frontend only. **No Go file is touched by any task in this plan.**

## Dependency shape

Tasks 1 and 2 are independent of each other and of everything else. Tasks 3–6
are a chain — each needs the previous task's files to exist.

```
T1 serialize ─┐
              ├─▶ T3 chip nodes ─▶ T4 @ mention ─▶ T5 editor ─▶ T6 shell + wiring
T2 chip view ─┘
```

Parallelism is limited on purpose. T3–T6 build one interlocking component; run
in parallel they produce components that do not fit together.

## File ownership

No two tasks write the same file. This is what makes the chain safe.

| Task | Writes |
|---|---|
| T1 | `composerSerialize.ts`, `composerSerialize.test.ts` |
| T2 | `ComposerChip.tsx`, `ComposerChip.test.tsx` |
| T3 | `composerNodes.ts`, `composerNodes.test.ts` |
| T4 | `composerMention.ts`, `composerMention.test.ts` |
| T5 | `ComposerPromptEditor.tsx`, `ComposerPromptEditor.test.tsx` |
| T6 | `ChatComposer.tsx`, `ComposerControls.tsx`, `AgentChatPane.tsx` |

All under `frontend/src/features/agent-chat/`.

---

## T1 — Serialization (pure)

The editor's document → the `string` sent to the backend, and back.

**Tests first.** Chip at start, at end, between words, two chips adjacent, chip
with surrounding whitespace, empty doc, text-only doc. A file chip for
`src/app.tsx` serializes to `@src/app.tsx`.

**Then implement.** Pure functions over a plain JSON document shape — no TipTap
import, no React, no DOM. This is what makes it testable in isolation.

**Done when:** `composerSerialize.test.ts` passes.

## T2 — Chip node view (presentational)

One React component for all three chip kinds, differing by icon and label.

**Tests first.** Renders label; renders the right icon per kind; the remove
button calls its handler.

**Then implement.** Follow the styling of `t3code/apps/web/src/components/chat/FileTagChip.tsx`
— but using this repo's existing semantic tokens (`bg-muted`, `text-foreground`,
`border-border`), never t3code's raw values. `--secondary-label` does not exist
here; use `text-muted-foreground`.

**Constraint:** the remove control renders inside this component. Nothing about
this chip may be portalled outside the editor's DOM — see the spec's §5.

**Done when:** `ComposerChip.test.tsx` passes.

## T3 — Chip node types (needs T1, T2)

Three TipTap inline atom nodes: `composerFileChip`, `composerSkillChip`,
`composerTerminalContextChip`. All three defined; only the file chip is ever
inserted in this plan.

**Tests first.** Each node round-trips through T1's serialization. Nodes are
inline and atomic.

**Then implement.** `ReactNodeViewRenderer` over T2's component.

**Done when:** `composerNodes.test.ts` passes, and T1's tests still pass.

## T4 — `@` mention extension (needs T3)

**Tests first.** The `allow` rule: fires at start of a word; does NOT fire
inside `src/foo` or `a@b.com`. Selecting a result inserts a `composerFileChip`.

**Then implement.** Mirror `frontend/src/features/rich-editor/slashCommand.ts` —
same `Suggestion` wiring, same `ReactRenderer` lifecycle, same `props.mount`
anchoring. Deviating from that file's shape needs a stated reason.

Data source is `searchWorktreeFiles(machine, worktreeId, pattern, {includeDirs:true})`
from `@/lib/machineApi` — never a raw `fetch`, which would break remote
machines. Debounce the query.

Register no plugin for `$` or `/`. They stay literal text.

**Done when:** `composerMention.test.ts` passes.

## T5 — Prompt editor (needs T4)

`ComposerPromptEditor.tsx` — assembles the extensions, owns the keymap.

**Tests first.**
- Enter submits; Shift+Enter inserts a newline and does not submit
- Enter with the mention menu open selects an item and does NOT submit
- typing `$` or `/` produces literal text and opens no menu
- selecting a file yields a value containing `@<path>`

**Then implement.** Explicit extension list — no `StarterKit`. Inline content
only: no headings, lists, marks, or code blocks. Outward value is a `string`,
so the parent's contract is unchanged.

Keymap priority is the highest-risk detail in this plan: the suggestion plugin
must see Enter before the submit handler does.

**Props:** `value`, `onChange`, `onSubmit`, `placeholder`, `disabled`,
`machine`, `worktreeId`.

**Done when:** `ComposerPromptEditor.test.tsx` passes.

## T6 — Shell and wiring (needs T5)

**Rewrite `ChatComposer.tsx`** to the spec's §1 structure:

```
<form max-w-3xl>  →  frame rounded-[22px] p-px  →  surface rounded-[20px]
   →  <div data-slot="composer-panels" />   (empty; A fills it)
   →  <ComposerPromptEditor />
   →  footer: controls ……… send/stop
```

Required, not optional:
- **Delete the `BOX` constant.** If it survives, the port did not happen.
- **Preserve the action-button logic and its comment** (`ChatComposer.tsx:128-145`):
  while generating, a non-empty draft sends, an empty draft interrupts.
- Keep `variant="hero"` / `"docked"` behavior.
- Keep the `@container/composer` dual render of `ComposerControls`.

**`ComposerControls.tsx`:** placement only. Its props and behavior do not change.

**`AgentChatPane.tsx`:** thread `machine` and `worktreeId` through to the editor,
alongside the existing `worktree={worktreeLabel}` prop — not replacing it.

**Done when:** these stay green, unmodified — `ChatComposer.test.tsx`,
`ComposerControls.test.tsx`, `AgentChatPane.test.tsx`, `MessagesTimeline.test.tsx`,
`eventReducer.test.ts`, `adapter.test.ts`, `timeline.test.ts`.

---

## Review, fix, finalize

Review runs once, over the whole change — not per task.

**Review lenses (parallel):** spec conformance; TDD honesty (do the tests
actually constrain the behavior, or are they written to pass?); the Enter/keymap
priority contract; regression risk in the untouched-by-contract files.

**Fix:** apply confirmed findings only.

**Finalize:** `npm run typecheck` and `npm test` from `frontend/`.

## Known-good baseline

`npm test` has **one pre-existing failure** in the monaco guard test. It is not
caused by this work and must not be "fixed" here. Any *second* failure is a real
regression.

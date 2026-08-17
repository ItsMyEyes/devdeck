# Composer — t3code Shell & TipTap Prompt Editor

> Spec 1d. Follows `2026-08-09-agent-chat-ai-elements-design.md`.
>
> First of several specs porting t3code's composer surface. This one ships the
> **shell** and the **prompt editor**; it deliberately ships no new agent
> capability. See "Where this sits" for the other pieces and their order.

## Where this sits

t3code's `apps/web/src/components/chat/ChatComposer.tsx` is 3,215 lines because
it is seven independent subsystems sharing one form. Porting it as one unit is
not executable. The decomposition, with the backend each piece needs:

| | Subsystem | Backend needed | State |
|---|---|---|---|
| **G** | Shell + prompt editor + controls | none | **this spec** |
| **A** | Pending user-input & approval panels | approval broker, CLI control protocol | contract exists, unimplemented |
| **F** | Banner stack | none | not started |
| **B** | Plan surface (`ProposedPlanCard`) | `ExitPlanMode` intercept, `thread.proposedPlans` | not started |
| **C** | Context attachments (images, terminal ctx, element ctx) | attachment store, terminal→composer bridge | not started |
| **D** | Command menu (`/` commands, `$` skills) | per-provider skill/command catalog | not started |
| **E** | Draft threads & prompt stash | none | not started |

Agreed order: **G → A → F**, then B/C/D/E. Each gets its own spec.

G is first because it is the only piece with zero backend dependency, and
because A's panels mount inside the shell G builds. Doing A first would mean
building those panels twice.

## Problem

`ChatComposer.tsx` (218 lines) is structurally sound but is a plain textarea in
a fought-with vendored box, and it cannot host what comes next.

**The box is not ours.** The composer is built on the vendored AI Elements
`PromptInput`, whose `InputGroup` hardcodes its own `rounded-md`, `border-input`,
`dark:bg-input/30`, and `shadow-xs`. `ChatComposer.tsx:88-104` is a ten-line
`BOX` constant of `[&>[data-slot=input-group]]:…` descendant overrides that
exists purely to re-point styles we do not own. Every further visual change pays
that tax again.

**There is nowhere to put the panels.** A's pending user-input and approval
panels render *inside* the composer surface, above the editor — that adjacency
is the whole point, because the panel and the text box are one interaction. The
current structure (`PromptInput` → `PromptInputBody` → `PromptInputTextarea`)
has no slot between the surface edge and the input.

**A textarea cannot carry structured context.** The prompt is a `string` in
`useState` (`ChatComposer.tsx:146`). A file reference, a skill, or a captured
terminal block has no representation in it. Every later subsystem that puts
something *into* the prompt (C, D) is blocked on this.

## Non-goals

This spec ships **no new agent capability**. After it lands, the user can do
exactly what they can do today, plus reference files with `@`. Specifically out
of scope:

- Approval and user-input panels (A) — the shell gets an empty slot, nothing more
- Image attachments, terminal contexts, element contexts (C)
- `$` skill and `/` command menus (D) — see "Dormant triggers"
- Banner stack (F), plan surface (B), drafts and stash (E)
- Any backend change. This spec touches no Go file.

## Design

### 1. Shell

Replace the vendored `PromptInput` shell with t3code's structure
(`t3code/apps/web/src/components/chat/ChatComposer.tsx:2652-2690`):

```
<form className="mx-auto w-full min-w-0 max-w-3xl">      ChatComposer.tsx
  <div className="group rounded-[22px] p-px …">          frame
    <div className="rounded-[20px] …">                   surface
      <div data-slot="composer-panels" />                ← empty in G; A fills it
      <ComposerPromptEditor … />                         ← new
      <footer>  controls ……… send/stop  </footer>        ← ComposerControls
    </div>
  </div>
</form>
```

The `p-px` frame is a one-pixel padding ring, so a frame class can paint a
border-width gradient without a pseudo-element. t3code uses it only for
ultrathink (`composerProviderState.tsx:75`); G leaves it unstyled but keeps the
element, so that state has somewhere to land later.

`variant="hero"` and `variant="docked"` both survive, unchanged in meaning.

Deleting `BOX` is a required part of this work, not a side effect. If it
survives, the port did not happen.

### 2. Contracts that must not change

Two behaviors are already-settled decisions in this repo. They move; they are
not redesigned.

**Enter sends, Shift+Enter inserts a newline.** Today `PromptInputTextarea` owns
this by calling `form.requestSubmit()`. It becomes a TipTap keymap. Priority
matters: when a suggestion menu is open, Enter selects the highlighted item and
must not reach the submit handler.

**One action button; the draft decides.** `ChatComposer.tsx:128-145` — while the
agent is generating, a non-empty draft makes the button *send* (steering an
in-flight turn is explicitly allowed by the decider), and an empty draft makes it
*interrupt*. Preserve the logic and its comment. `waiting` is the state where the
agent is asking the user something, which is exactly when a click must send.

### 3. Prompt editor

New `frontend/src/features/agent-chat/ComposerPromptEditor.tsx`, built on TipTap
— already a dependency (`@tiptap/core`, `@tiptap/react`, `@tiptap/suggestion`,
`@tiptap/pm`). **Lexical is not introduced.** t3code uses it, but this repo
already ships TipTap plus a working `@tiptap/suggestion` implementation, and a
third rich-text framework beside TipTap and Monaco buys nothing a user can see.

The editor is plain-text-shaped: no headings, lists, marks, or code blocks. Its
document is inline content only — text plus chip nodes. `StarterKit` is not
used; the extension set is assembled explicitly.

**Value contract.** The editor's outward value is a `string`, the same as the
textarea's, so `onSend` and the whole parent chain are unchanged. Chips
serialize into that string via their node spec's text representation.
Serialization is a pure function and is unit-tested directly, not through the
DOM.

A file chip for `src/app.tsx` serializes to the markdown link
`[app.tsx](src/app.tsx)` — t3code's own format (`serializeComposerFileLink` in
`packages/shared/src/composerTrigger.ts`), whose escaping rules are ported with
it.

> An earlier draft of this spec said `@src/app.tsx`. That form is broken by
> construction and was corrected during implementation: a bare prefix has no
> terminator, so `@src/app.tsxplease` and `@a.ts@b.ts` are both reachable, and
> no separator rule repairs it in general because a path may contain the
> separator (`@my file.tsx`). Brackets delimit the path themselves.

### 4. Triggers

Follow `features/rich-editor/slashCommand.ts` exactly — same `Suggestion`
wiring, same `ReactRenderer` lifecycle, same `props.mount` anchoring. That file
is the reference implementation; deviating from its shape needs a reason.

| Trigger | Source | State in G |
|---|---|---|
| `@` file/folder | `searchWorktreeFiles(machine, worktreeId, pattern, {includeDirs:true})` (`lib/machineApi.ts:204`) | **live** |
| `$` skill | per-provider skill catalog | dormant |
| `/` command | per-provider command catalog | dormant |

`@` is live because its backend already exists and is already fuzzy-matched
(`handler/worktree_file.go:256` → `service/worktree_file.go:1167`). Results are
debounced.

**Call the typed helper, not `fetch`.** `searchWorktreeFiles` routes through
`machineRequest`, which is what makes the call work when the worktree lives on a
remote machine. A hand-rolled `fetch('/api/worktrees/…')` would appear to work
locally and silently fail for every remote machine.

**Threading its two arguments is part of this work.** `AgentChatPane` already
holds both `machine` and `worktreeId` (`AgentChatPane.tsx:127`), but today it
passes only `worktree={worktreeLabel}` down (`:200`) — a display string for
`ChatStatusStrip`, not an id. `machine` and `worktreeId` must be threaded to
`ComposerPromptEditor` as new props, alongside the existing label prop rather
than replacing it.

**Dormant triggers.** `$` and `/` get their node types and serialization now,
but no `Suggestion` plugin is registered for them. A menu that opens empty is
worse than no menu — and D's job then becomes registering a plugin, not
reopening the editor. A `$` or `/` typed in G is ordinary text.

`allow` must keep `@` from firing mid-token, so a pasted path or an email
address does not open the menu — mirroring `slashCommand.ts`'s start-of-word
rule.

### 5. Chips

Three node types, all inline atoms: `composerFileChip` (live),
`composerSkillChip` and `composerTerminalContextChip` (defined, never inserted
in G). One React node view shared by all three, differing by icon and label.

A chip's remove control must live **inside** the node view. This repo has
already been bitten by the alternative: hover controls rendered outside
`view.dom` unmount because `posAtCoords` returns null (see the notion editor's
gutter). Do not portal chip UI outside the editor.

### 6. Controls

`ComposerControls.tsx` keeps its full functionality — model picker, effort,
context window and its meter, interaction mode, runtime mode. Its
`ComposerControlsProps` (`ComposerControls.tsx:162-195`) is already at parity
with t3code's control row; only placement changes, into the shell's footer.

The `@container/composer` dual render stays. It exists because four pills in a
`flex-wrap` row stack into four full-width rows at real pane widths, and that
problem is unchanged by this spec.

## Data flow

```
user types ──▶ TipTap doc ──serialize──▶ string ──▶ ChatComposer state
                   ▲                                      │
      chip insert  │                                      ▼ Enter
                   │                              onSend(text)  (unchanged)
             @ suggestion
                   │
                   ▼
        GET /api/worktrees/{id}/files/search
```

Nothing downstream of `onSend` changes. The socket layer, the reducer, and the
backend see exactly what they see today.

## Testing

TDD. Pure logic first, and most of this is pure logic.

**Unit (no DOM):**
- chip + text → string serialization, including a chip at the start, at the end,
  adjacent to another chip, and with surrounding whitespace
- `@` trigger `allow` rule: fires at start of word, does not fire inside
  `src/foo` or `a@b.com`
- send-vs-interrupt decision (moved from `ChatComposer.tsx`, behavior identical)

**Component:**
- Enter submits; Shift+Enter does not
- Enter with the suggestion menu open selects an item and does not submit
- selecting a file inserts a chip and the serialized value contains `@<path>`
- `$` and `/` produce literal text and open no menu

**Regression — must stay green, unmodified:**
`ChatComposer.test.tsx`, `ComposerControls.test.tsx`, `AgentChatPane.test.tsx`,
`MessagesTimeline.test.tsx`, `eventReducer.test.ts`, `adapter.test.ts`,
`timeline.test.ts`.

`npm test` shows one pre-existing failure in the monaco guard test. It is not a
regression from this work and must not be "fixed" as part of it.

## Risks

**Enter priority.** The highest-risk detail. A suggestion menu that lets Enter
through sends a half-typed message; a keymap that swallows Enter breaks sending
entirely. Both directions are covered by the component tests above.

**Chip hover UI.** Covered in §5 — inside the node view, never portalled out.

**Commit granularity.** The pre-commit hook typechecks the whole project, so
this cannot be committed file-by-file. G lands as one commit.

## Files

**New:** `ComposerPromptEditor.tsx`, `composerMention.ts` (the `@` extension),
`ComposerChip.tsx` (shared node view), `composerSerialize.ts` (+ tests).

**Rewritten:** `ChatComposer.tsx` — shell replaced, `BOX` deleted, action-button
logic preserved.

**Adjusted:** `ComposerControls.tsx` (placement only), `AgentChatPane.tsx`
(follows prop changes).

**Untouched:** every Go file, `MessagesTimeline.tsx`, `eventReducer.ts`,
`adapter.ts`, `useAgentChatSocket.ts`, the vendored `components/ai-elements/*`.

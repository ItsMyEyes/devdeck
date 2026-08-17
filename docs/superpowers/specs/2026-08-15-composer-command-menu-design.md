# Composer — Slash Commands & Skills Menu

> Spec 1e, subsystem **D**. Follows `2026-08-14-composer-shell-tiptap-editor-design.md`.
>
> This spec turns on the two triggers G deliberately left dormant. It adds no
> node types, no serialization framework, and no editor structure — G built all
> of that. It registers two `Suggestion` plugins, supplies their catalogs, and
> **fixes the skill chip's serialized form before anything can insert one.**

## Where this sits

G's decomposition table (`2026-08-14-composer-shell-tiptap-editor-design.md:15-25`)
lists this piece as:

| | Subsystem | Backend needed | State |
|---|---|---|---|
| **D** | Command menu (`/` commands, `$` skills) | per-provider skill/command catalog | **this spec** |

Agreed order was G → A → F, then B/C/D/E. D is taken out of that tail because
its "backend needed" column turned out to be half-satisfied already: the
per-machine skill catalog exists end to end and is only missing a consumer.

**What D depends on, and what already exists:**

| Dependency | Status | Where |
|---|---|---|
| Chip node types (`composerSkillChip`) | exists, never inserted | `composerNodes.ts:151`, registered at `ComposerPromptEditor.tsx:168` |
| Chip node view (icon `Box` for `skill`) | exists | `ComposerChip.tsx:24,33-37` |
| Doc→string serialization | exists, **wrong for skills** | `composerSerialize.ts:106-119` — see Problem |
| `Suggestion` reference wiring | exists | `rich-editor/slashCommand.ts:24-66`, ported once at `composerMention.ts:191-243` |
| Skill catalog, per machine, per agent | exists end to end | `detect/skills.go:37-82` → `registry/local.go:88-100` → `handler/agent.go:54-61` → route `cmd/server/main.go:643` → `machineApi.ts:506-508` → `queries.ts:1425-1432` |
| Interaction-mode command sink | exists | `useAgentChatSocket.ts:47,325`; surfaced as `controls.setInteractionMode` at `AgentChatPane.tsx:158-161` |
| Slash-command catalog | **absent** | no `SlashCommand` type, route, or concept in `backend/` — see Non-goals |

D touches **no Go file**. Everything it needs on the backend is already
routed and already reachable from the browser through `machineRequest`.

D does not depend on C (attachments) and does not block on it. The one place
the two meet is `CHIP_PREFIX` (`composerSerialize.ts:54-57`), which D narrows
to `terminalContext` only, leaving C's entry — and its warning comment —
untouched.

## Problem

### 1. The skill chip's serialized form is the defect G already fixed once

G's §3 records the correction it had to make mid-implementation
(`2026-08-14-composer-shell-tiptap-editor-design.md:136-138`): `@src/app.tsx`
is "broken by construction … a bare prefix has no terminator". Files were
moved to `[app.tsx](src/app.tsx)`.

The skill chip was left on exactly the form that was just rejected.
`composerSerialize.ts:54-57`:

```ts
const CHIP_PREFIX: Record<Exclude<ComposerChipKind, 'file'>, string> = {
  skill: '$',
  terminalContext: '@',
}
```

and `composerSerialize.ts:112` returns `` `${CHIP_PREFIX[node.kind]}${node.value}` ``.
That file's own comment names the obligation this spec is discharging: *"The
spec that turns either on owns giving it a self-delimiting form; neither has
one here, so neither may be inserted next to arbitrary text until then."*

The defect is not hypothetical and does not need an exotic skill name.
`serializeComposerDoc` joins inline nodes with `''` (`composerSerialize.ts:119`),
and a chip is a ProseMirror **inline atom** (`composerNodes.ts:112-114`) — the
caret sits directly after it and the next character typed lands with no
separator:

| Document | Sent string today | Recoverable? |
|---|---|---|
| chip(`review`) + text(`please`) | `$reviewplease` | no |
| chip(`review`) + chip(`refactor`) | `$review$refactor` | no |
| chip(`code-review`) + text(`.`) | `$code-review.` | no — `.` is a legal name char (`detect/skills.go:477`) |

t3code gets away with `$name` only because it enforces three things D cannot.
Its parser is `SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z][a-zA-Z0-9:_-]*)(?=\s)/g`
(`gg/t3code/packages/shared/src/composerInlineTokens.ts:21`) — it *requires* a
whitespace lookahead, and it gets one because every insertion site appends a
literal trailing space (`gg/t3code/apps/mobile/src/features/threads/ThreadComposer.tsx:565`,
`` replacement = `$${item.skill.name} ` ``). A trailing space is a separator
rule, and G already recorded why separator rules do not repair this class of
form in general.

> **A correction, recorded because the first version of this argument was
> wrong.** This spec initially claimed the charset was the primary defect —
> that DevDeck skill names can contain spaces, so `$name` cannot represent
> them. I then read every `SKILL.md` on this machine: all 80+ names are
> slugs, and **zero** contain a character outside `[A-Za-z0-9._:@-]`. The
> charset claim is therefore a latent risk, not a present bug, and it is
> demoted below. What survives verification is the missing right-hand
> terminator above, which reproduces today with a perfectly ordinary
> `code-review`.

The charset risk is still real, just second: `ReadSkills` takes `Name`
verbatim from `SKILL.md` frontmatter (`detect/skills.go:582-583`, cleaned only
of surrounding quotes by `cleanYAMLScalar` at `:608-616`) and **never** calls
`validateSkillName`. That validator (`detect/skills.go:469-483`, restricting
names to `[A-Za-z0-9._:@-]`, ≤128 chars) is wired only into the three write
paths — `:127`, `:270`, `:309`. Nothing rejects a skill whose frontmatter says
`name: Data Report`; the list endpoint will happily return it.

### 2. Two catalogs exist in the app and neither reaches the composer

The skill catalog is complete and machine-scoped — `qk.agentSkills(machineId, agentId)`
(`keys.ts:11`), `fetchAgentSkills` over `machineRequest` (`machineApi.ts:506-508`),
`useAgentSkills` (`queries.ts:1425-1432`) — and is consumed today only by the
Agent Management settings UI. The composer's `$` has no plugin at all
(`composerMention.ts:25-27` states this explicitly).

The interaction-mode sink is equally complete — `setInteractionMode` dispatches
`thread.interaction-mode.set` (`useAgentChatSocket.ts:325`) and is already
handed to the composer as `controls.setInteractionMode`
(`ComposerControls.tsx:184`, populated at `AgentChatPane.tsx:158-161`) — and is
reachable only by opening a pill.

### 3. Every trigger in this composer silently dies on the second line

Found while reading `@tiptap/suggestion` to plan the two new registrations, and
it applies to the `@` trigger shipping today.

`findSuggestionMatch` rejects a match whose preceding character is not in
`allowedPrefixes`, which defaults to `[' ']`
(`node_modules/@tiptap/suggestion/dist/index.js:31-35`, default at `:646`). The
guard is `new RegExp('^[' + allowedPrefixes.join('') + '\0]?$')`. Executed
against the candidates:

```
""   -> true      "\n" -> false
" "  -> true      "\t" -> false
```

G's editor has no `hardBreak` node: Shift+Enter inserts a literal `\n` into the
text node (`ComposerPromptEditor.tsx:118-121`, and its header at `:14-20`
explains why). So the character before a trigger typed at the start of any
continuation line is `\n`, the match is discarded before `allow` ever runs, and
`mentionAllow`'s deliberate `/\s/` rule (`composerMention.ts:71-73`) never gets
a say. Registering `$` and `/` without fixing this ships the same hole twice
more.

Scope note: this was verified by reading the installed package and executing
its prefix regex. It was **not** reproduced in a running app; the component
test named in Testing is what will confirm it.

## Non-goals

D ships two working menus and one corrected serialization. Explicitly out of
scope:

- **`/model`.** t3code's most-used command, and it cannot work here. The model
  picker owns its own `open` state (`ModelPicker.tsx:213-215`), and
  `ChatComposer` mounts `ComposerControls` — and therefore `ModelPicker` —
  **twice**, once inline and once inside a collapsed overflow popover
  (`ChatComposer.tsx:208` and `:219`). A controlled-open prop would open both,
  one of them inside a closed popover. `/model` needs the picker hoisted out of
  the dual render first; that is not this spec.
- **Provider slash commands.** t3code's second command variant
  (`gg/t3code/apps/web/src/components/chat/ComposerCommandMenu.tsx:39-46`) has
  no DevDeck counterpart. The data is *visibly* available and *actively*
  dropped: the Claude CLI's init line carries `"slash_commands":[…]` and
  `"skills":[…]` (see `claude/testdata/turn.ndjson:7`), but `wireLine`
  (`claude/parse.go:148-155`) declares no such fields and `parseSystem`
  (`:200-212`) reads only `session_id`. Capturing it means a new event payload,
  an orchestration field, a socket field and a view-model field — and it would
  still be empty until a session starts, so the first turn's menu would show
  nothing. Its own spec.
- **Runtime-mode commands** (`/approval-required` etc.). The four permission
  options exist (`ComposerControls.tsx:68-73`); adding commands for them is one
  array literal once the pattern lands, and not required to prove it.
- **Parsing chips back out of a string.** `parseComposerText`
  (`composerSerialize.ts:127-130`) stays one-way, for the reason its own
  comment gives. The new form is *designed* to be parseable — see §1's
  discrimination invariant — but nothing in D parses it.
- **Rendering skill chips in the transcript.** The user's own turn is rendered
  verbatim, not as markdown (`MessagesTimeline.tsx:97-98`), so what the
  operator sees in their bubble is the literal serialized string. That is a
  known consequence, not a regression, and it is identical to what the shipped
  `@` file chip already does. t3code's `SkillInlineText.tsx` is the eventual
  answer; it is not this spec.
- **Send-time command interception.** t3code additionally consumes a
  standalone `/plan` at submit (`ChatView.tsx:4902` via
  `parseStandaloneComposerSlashCommand`, `composerTrigger.ts:127-137`). Not
  ported: it is a second path to the same effect whose only unique reachability
  is "user dismissed the menu with Escape", and its failure mode is swallowing
  a message whose entire text is legitimately `/plan`.
- **Any backend change.** No Go file is touched.
- **Any editor restructuring.** No new node type, no change to the document
  schema, no change to the Enter/Shift+Enter contract.

## Design

### 1. The skill chip's self-delimiting form

A skill chip for `code-review` serializes to:

```
[$code-review](skill:code-review)
```

Brackets delimit the label; the parenthesis terminates the whole token. The
three broken rows from Problem §1 become:

| Document | Sent string | Recoverable? |
|---|---|---|
| chip(`review`) + text(`please`) | `[$review](skill:review)please` | yes |
| chip(`review`) + chip(`refactor`) | `[$review](skill:review)[$refactor](skill:refactor)` | yes |
| chip(`Data Report`) | `[$Data Report](skill:Data%20Report)` | yes |

This is not a new mechanism. It reuses `escapeMarkdownLinkLabel` and
`encodeMarkdownLinkDestination` verbatim (`composerSerialize.ts:37-48`, already
ported from t3code's `composerTrigger.ts:25-36` and already unit-tested at
`composerSerialize.test.ts:74-78`). The destination is `'skill:'` prefixed onto
`encodeMarkdownLinkDestination(name)`, so the scheme is literal and cannot be
swallowed by the encoder.

Encoding was checked by execution rather than assumed, because `encodeURI`'s
treatment of `%` decides whether the form round-trips at all:

```
"code-review" -> "code-review"          "a%b"        -> "a%25b"
"Data Report" -> "Data%20Report"        "my (skill)" -> "my%20%28skill%29"
"a?b#c"       -> "a%3Fb%23c"            "emoji🎨"    -> "emoji%F0%9F%8E%A8"
```

All six survive `decodeURIComponent` unchanged. `encodeURI` does escape `%`.

**The discrimination invariant.** A file chip's destination is a
worktree-relative path and never carries a URI scheme; a skill chip's
destination always begins `skill:`. The two forms are therefore mutually
exclusive by construction, which is the property any future parser needs —
t3code's own file-link recogniser already rejects scheme-bearing destinations
for exactly this reason (`composerInlineTokens.ts:46-48`). This is asserted as
a unit test, not left as an intention.

**No trailing space is inserted.** t3code must append one
(`ThreadComposer.tsx:565`); D must not. The form carries its own terminator,
and a phantom space would be indistinguishable from one the user typed.

`CHIP_PREFIX` narrows to `Record<Exclude<ComposerChipKind, 'file' | 'skill'>, string>`
— one entry, `terminalContext`, keeping its bare-prefix form **and its warning
comment**. C owns fixing that one, on the same grounds this spec owns fixing
`skill`.

`value` remains the exact `Skill.name` and is the only thing serialized;
`label` stays cosmetic (`composerSerialize.ts:66-72`, `composerNodes.ts:93-96`).

### 2. Two `Suggestion` registrations, one shared popup

Both follow `rich-editor/slashCommand.ts:24-66` and its port at
`composerMention.ts:191-243` — same `Suggestion` wiring, same `ReactRenderer`
lifecycle, same `props.mount` anchoring, same `onKeyDown` returning `true` to
consume the key. Each gets its own `PluginKey`.

| Trigger | Catalog | `command()` outcome |
|---|---|---|
| `$` | `useAgentSkills(machine, agentId)` | inserts a `composerSkillChip` at `range` |
| `/` | built-in list, in-module | deletes `range`, performs the action, inserts nothing |

`/` inserts no node, which is why G defined only three chip types. A command is
an action on the composer, not a reference embedded in the prompt.

**Built-in commands.** Deliberately two, each mapping onto a sink that already
works today:

| Command | Action | Sink |
|---|---|---|
| `/plan` | `setInteractionMode('plan')` | `ComposerControls.tsx:184` → `useAgentChatSocket.ts:325` |
| `/build` | `setInteractionMode('default')` | same |

`/build`, not t3code's `/default`, because "Build" is this product's own word
for `InteractionMode.default` (`ComposerControls.tsx:50-53`). `default` is
carried as a match keyword so muscle memory from t3code still lands.

**Extraction, not a third copy.** `composerMention.ts`'s `MentionMenu`
(`:99-173`) is private to that file. D would otherwise write it twice more, so
it moves to a shared `ComposerSuggestionMenu.tsx` — a real `.tsx`, since it is
no longer constrained by a single-file task boundary — taking items as
`{ id, label, description?, icon }` and keeping the existing highlight,
arrow-key, Enter/Tab and `scrollIntoView` behaviour byte for byte. The proof
that this is an extraction and not a redesign is that `composerMention.test.ts`
stays green **unmodified**.

**Empty is now information.** G's rule was *"a menu that opens empty is worse
than no menu"* (`2026-08-14-…:168-171`) — an argument about registering a
plugin with no catalog behind it. With a real catalog, an empty result means
something, and the frontend rules require an explicit empty state for every
data surface. So the popup renders `Searching…` / `No skills found` /
`Couldn't load skills for <agent>`, matching t3code's own three-state popup
(`ComposerCommandMenu.tsx:171-196`). `ListSkills` returns HTTP 400 for an
unsupported agent (`handler/agent.go:56-59`), so the error branch is reachable,
not decorative.

### 3. Matching

`matchBlockCommands` (`rich-editor/blocks.ts:171-179`) is the in-repo
reference: lowercase substring over label plus keywords, no ranking. That is
right for the 2-item command list and wrong for skills — this machine has 80+,
and a plain `includes` filter returns them in directory order.

So: one small pure matcher, substring over `name` + `description`, partitioned
into a prefix-match bucket ahead of a contains bucket, each bucket sorted by
name, capped at 20 (matching `MENTION_RESULT_LIMIT`, `composerMention.ts:51`).

t3code's `searchProviderSkills` / `searchSlashCommandItems`
(`providerSkillSearch.ts:69-105`, `composerSlashCommandSearch.ts:45-83`) are
**not** ported. They are 192 lines of shared `searchRanking` scoring five
fields with per-field base weights, and three of those fields
(`shortDescription`, `scope`, `displayName`) do not exist on DevDeck's
`AgentSkill` (`store/types.ts:381-386` / `domain/agent.go:22-27`). Neither does
`enabled`, so t3code's `enabled` filter (`providerSkillSearch.ts:74`) has
nothing to filter.

The query need not equal the name. `@tiptap/suggestion`'s default match runs to
the next whitespace, so `$data` is the most a user can type toward a skill
called `Data Report` — and that is fine, because the query drives *search* while
the chip carries the exact `value`. Spaces in names are a serialization
problem, which §1 solved, not a search problem.

### 4. Trigger guards

| Trigger | Rule | Source |
|---|---|---|
| `$` | start of word | reuses `isMentionWordStart` (`composerMention.ts:71-73`) |
| `/` | start of line | t3code's own stricter rule for commands (`composerTrigger.ts:65-68` matches `/` only against `linePrefix` from `lineStart`) |

`/` is line-start because `fix the /plan thing` and `https://host/path` must not
open a menu. It is implemented through `allow` reading the character before
`range.from` (`''` or `'\n'`), **not** through `@tiptap/suggestion`'s
`startOfLine` option: that option anchors `^` against
`$position.nodeBefore.text` (`dist/index.js:19-27`), and after a chip atom the
preceding text node begins mid-line, so `^` would match a position with a chip
immediately to its left.

All three triggers — `@` included — pass `allowedPrefixes: [' ', '\n']`,
fixing Problem §3. This is the single line `@` is missing today.

### 5. Wiring

`ComposerPromptEditor` gains three props: `agentId`, `skills` and
`onInteractionModeChange`. Extensions are declared **after**
`createComposerSubmitKeymap`, alongside `createComposerMention` — the file's
header (`ComposerPromptEditor.tsx:32-54`) explains why later declaration means
earlier keydown dispatch, and Enter must reach an open menu before it reaches
submit. Order *among* the three triggers is irrelevant: `@tiptap/suggestion`'s
`handleKeyDown` only intercepts when its own plugin state is active, and their
`char`s are mutually exclusive at any cursor.

The catalogs are read through a ref snapshot, not a closure — the exact pattern
`createComposerSubmitKeymap` already uses (`ComposerPromptEditor.tsx:107-125`,
`:151-152`) — because the extension list is built once and only rebuilt on
`[machine.id, worktreeId]` (`:199-203`). A closure over `skills` would freeze
the catalog at its first (loading, empty) value.

**`AgentChatPane.tsx` is not modified, and that is a result, not an accident.**
`ChatComposer` already receives everything D needs inside `controls`
(`ChatComposer.tsx:96`): `worktreeAgentId` (`AgentChatPane.tsx:151`), `model`
(`:148`) and `setInteractionMode` (`:158-161`). The effective agent for the next
turn is `controls.model?.agentId ?? controls.worktreeAgentId` — the model picker
can move a thread to a different agent (`ModelPicker.tsx:50-55`), and the skill
catalog must follow the agent that will actually run, not the worktree's
default.

`useAgentSkills` is called in `ComposerPromptEditor`, closest to its only
consumer, and passed down as `skills`.

## Data flow

```
                 ┌─ $ ──▶ useAgentSkills(machine, model?.agentId ?? worktreeAgentId)
                 │            │  GET /api/agents/{agentId}/skills  (via machineRequest)
                 │            ▼
                 │        match(query) ──▶ ComposerSuggestionMenu
                 │            │ select
                 │            ▼
user types ──────┤        insert composerSkillChip{value: name}
                 │            │
                 │            ▼
                 │        serializeComposerDoc ──▶ "[$name](skill:name)"
                 │
                 └─ / ──▶ BUILT_IN_COMMANDS ──▶ ComposerSuggestionMenu
                              │ select
                              ▼
                          deleteRange(range) + controls.setInteractionMode(mode)
                              │                        │
                              ▼                        ▼
                          (no text inserted)   thread.interaction-mode.set
```

The `$` path ends in the same string `onSend` already receives; nothing
downstream of `onSend` changes. The `/` path never reaches `onSend` at all — it
dispatches on the socket the composer's pill already uses.

`GET /api/agents/{agentId}/skills` is reached through `machineRequest`, never a
hand-rolled `fetch` — G's §4 states the reason and it is unchanged: the worktree
may live on a remote machine.

## Testing

TDD, and as with G most of this is pure logic.

**Unit (no DOM):**
- skill chip → `[$name](skill:name)`, including: adjacent to text on both
  sides, adjacent to another skill chip, adjacent to a file chip, a name with a
  space, a name with `[`/`]`, a name with `(`/`)`, a name with `%`
- the discrimination invariant: no file-chip output has a scheme-bearing
  destination; every skill-chip output does
- `label` is ignored by serialization, `value` is not
- the matcher: prefix hits before contains hits, description hits included,
  empty query returns everything, cap honoured
- `/` line-start rule: fires at `''` and after `'\n'`, does not fire in
  `fix the /plan thing` or `https://host/path`
- `$` word-start rule (reuses `isMentionWordStart`'s existing coverage)

**Component:**
- typing `$` opens the menu; selecting inserts a chip whose serialized value is
  the bracketed form
- typing `/pl` and pressing Enter calls `onInteractionModeChange('plan')`, sends
  nothing, and leaves the document empty
- Enter with either menu open does not submit; Enter with both closed does
  (G's highest-risk detail, re-asserted for two more plugins)
- **`@` after Shift+Enter opens the menu** — the regression test for
  Problem §3. Must be written failing first, against the current
  `allowedPrefixes` default, or the fix is unverified.
- the three catalog states render: loading, empty, error

**Regression — must stay green, unmodified:**
`composerMention.test.ts` (the proof the popup extraction changed no
behaviour), `composerNodes.test.ts`, `ComposerChip.test.tsx`,
`ComposerControls.test.tsx`, `MessagesTimeline.test.tsx`, `eventReducer.test.ts`,
`timeline.test.ts`, `adapter.test.ts`.

**Regression — must be modified, minimally and deliberately:**
`composerSerialize.test.ts:80-82` asserts `'$review'` today. That assertion is
the defect; it is rewritten, not deleted.

Three test files mock `@/features/data/queries` as a whole-module replacement
exposing only `useAgents`/`useAgentModels` (`ChatComposer.test.tsx:15-19`,
`AgentChatPane.test.tsx:42-45`) or do not mock it at all
(`ComposerPromptEditor.test.tsx:38-40`, which mocks only `@/lib/machineApi`).
Introducing `useAgentSkills` anywhere in the composer subtree breaks all three
with `useAgentSkills is not a function` or a missing `QueryClientProvider`.
There is no placement that avoids this — the hook must live somewhere in that
subtree. Each file gains one stub line. This is called out because G's rule was
that those files stay green *unmodified*, and this is a deliberate, named
exception rather than a silent edit.

`npm test` shows one pre-existing failure in the monaco guard test. Unrelated,
and not to be "fixed" here.

## Risks

**Changing serialization before there is a producer is the whole point, and
also the only chance to do it cheaply.** No skill chip has ever been inserted,
so no stored draft, no sent message and no test fixture contains `$name`. Once
`$` ships, the form is in users' transcripts. Ordering the fix ahead of the
producer is not tidiness; it is the difference between an edit and a migration.

**Enter priority, times three.** G's highest-risk detail now has two more
plugins competing for the key. Mitigated structurally (both declared after the
submit keymap, per `ComposerPromptEditor.tsx:32-54`) and empirically (the
component tests above). G's own header records that it verified this by
spiking the wrong order and watching the assertion fail; the same spike is
worth repeating rather than trusting the reasoning.

**The popup extraction is where an "invisible" regression would hide.**
`composerMention.test.ts` passing unmodified is the gate. If it needs an edit,
the extraction changed behaviour and should be reconsidered rather than
accommodated.

**`allowedPrefixes` may not be the only reason a second-line trigger fails.**
The prefix regex was verified by execution; the end-to-end path through
ProseMirror was not. If the failing-first test does not fail, the diagnosis in
Problem §3 is wrong and the fix must not be committed on the strength of the
reasoning alone.

**A stale catalog after an agent switch.** The skill list is keyed on the
effective agent, and the model picker can change it mid-thread. The ref
snapshot keeps the extension reading the current list, but the react-query key
must include the effective agent id (`qk.agentSkills`, `keys.ts:11`) or the
menu shows the previous agent's skills.

**Commit granularity.** The pre-commit hook typechecks the whole project, so
this cannot land file-by-file. D lands as one commit.

## Files

**New:**
`ComposerSuggestionMenu.tsx` (popup extracted from `composerMention.ts`),
`composerSkillTrigger.ts` + `.test.ts` (the `$` extension and its matcher),
`composerSlashTrigger.ts` + `.test.ts` (the `/` extension and `BUILT_IN_COMMANDS`).

**Changed:**
`composerSerialize.ts` (skill chip form; `CHIP_PREFIX` narrowed to
`terminalContext`) and `composerSerialize.test.ts` (`:80-82` rewritten, cases
added) — `composerMention.ts` (uses the shared popup; `allowedPrefixes`) —
`ComposerPromptEditor.tsx` (two extensions, three props, catalog ref,
`allowedPrefixes`) and `ComposerPromptEditor.test.tsx` — `ChatComposer.tsx`
(derives the effective agent id from `controls`, passes
`controls.setInteractionMode` through) and `ChatComposer.test.tsx` —
`AgentChatPane.test.tsx` (mock stub only).

**Untouched:** every Go file — `AgentChatPane.tsx` (see §5) —
`ComposerControls.tsx`, `ModelPicker.tsx`, `ComposerChip.tsx`,
`composerNodes.ts` — `MessagesTimeline.tsx`, `eventReducer.ts`, `timeline.ts`,
`adapter.ts`, `useAgentChatSocket.ts` — `features/rich-editor/*` — the vendored
`components/ai-elements/*`.

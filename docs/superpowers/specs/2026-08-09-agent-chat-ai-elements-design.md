# Agent Chat — AI Elements Adoption & Palette A

> Spec 1c. Follows `2026-08-07-agent-chat-t3code-parity-design.md`, which fixed
> the composer's structure. This spec replaces the hand-rolled chat surface with
> [AI Elements](https://elements.ai-sdk.dev) components and re-tunes the color
> tokens the new components consume.

## Problem

The pane is structurally correct and visually unfinished. Three concrete
defects, all in `MessagesTimeline.tsx`:

**Agent output is not rendered.** `MessageBubble` prints `item.text` in a
`whitespace-pre-wrap` div. Every heading, list, table, and fenced code block the
agent emits reads as one undifferentiated grey wall. `react-markdown`, `mermaid`,
and `monaco-editor` are already in `package.json` and none of them touch this
surface.

**Tool calls are opaque.** `ToolRow` renders a wrench glyph, `item.toolName`, and
a status dot. The tool's arguments are already on the wire — `parse.go:331`
sends `detail: {toolCallId, name}` on `item.started` and `parse.go:378` sends the
accumulated input JSON on `item.completed` — and `eventReducer.applyForwarded`
discards both. The user cannot see which file an `Edit` touched.

**Two shadcn semantic tokens are dead.** `--muted` resolves to
`--devdeck-pane`, identical to `--background`, so `bg-muted` is invisible.
`--border` resolves to `--devdeck-line` (`#7d8180`), which hard-outlines
anything that uses `border-border`. Neither has a call site today, so the defect
is latent — and it lands the moment a component library that uses those
utilities is installed.

Missing outright: copy actions, a scroll-to-bottom affordance, a streaming
indicator, and a token/context meter.

## Decisions

**Adopt AI Elements wholesale for the chat surface** rather than borrowing its
patterns. Vendored via the shadcn CLI, upstream source left unmodified so
future fixes can be re-pulled.

**Accept Radix as a second primitive library**, scoped to
`src/components/shadcn/`. Rewiring 15 vendored files onto `@base-ui/react`
would diverge them from upstream permanently; a full shadcn migration would
touch every dialog, select, and tooltip in the app. Neither is worth it for one
pane. The cost is accepted and bounded: Radix appears only inside
`src/components/{shadcn,ai-elements}/`, base-ui everywhere else.

**Palette A — refine, do not replace.** The teal/graphite identity and every
contrast ratio recorded in `DESIGN.md` stay. What the palette is missing is an
*elevation ladder*: one pane color cannot separate a code block from a tool card
from the message flow behind them.

**Palette changes are app-wide but additive.** `border-border` and `bg-muted`
have zero call sites across 120 component files (`grep -rl` over `src/**/*.tsx`),
so re-pointing the shadcn semantic vars cannot regress existing UI. The three
new `--devdeck-*` surface tokens are new names; no existing value is replaced.

## Install topology

`shadcn add` writes components to `aliases.ui`. `src/components/ui/` already
holds base-ui `button.tsx`, `select.tsx`, `tooltip.tsx`, `input.tsx`,
`switch.tsx`, and `textarea.tsx` — pointing the CLI there would overwrite them
and break the app. Therefore:

```
frontend/components.json               # hand-written; do NOT run `shadcn init`,
                                       #   it rewrites globals.css and tsconfig
  aliases.ui    → "@/components/shadcn"
  aliases.utils → "@/lib/utils"        # existing cn()
  tailwind.css  → "src/styles/globals.css"
  tailwind.baseColor → neutral, cssVariables: true

frontend/src/components/shadcn/*       # vendored Radix primitives
frontend/src/components/ai-elements/*  # vendored AI Elements, unmodified
```

Install per component. Never `registry/all.json` — the `all` bundle pulls
`@xyflow/react`, `media-chrome`, and `@rive-app/react-webgl2` for canvas and
audio components this app has no use for.

### Registry dependencies (verified against the live registry, 2026-08-09)

| Component | npm | shadcn primitives |
|---|---|---|
| `conversation` | `ai`, `use-stick-to-bottom` | button |
| `message` | `streamdown`, `@streamdown/{cjk,code,math,mermaid}`, `ai` | button, button-group, tooltip |
| `reasoning` | `@radix-ui/react-use-controllable-state`, `streamdown` | collapsible, shimmer |
| `tool` | `ai` | badge, collapsible, code-block |
| `code-block` | `shiki` | button, select |
| `task` | — | collapsible |
| `prompt-input` | `ai`, `nanoid` | command, dropdown-menu, hover-card, input-group, select, spinner, tooltip |
| `context` | `ai`, `tokenlens` | button, hover-card, progress |

`lucide-react`, `class-variance-authority`, `clsx`, `tailwind-merge`, and
`tw-animate-css` are already installed.

**Not vendored:** canvas / edge / node / controls, audio-player / mic-selector /
voice-selector / transcription / speech-input, web-preview, image, artifact,
sandbox, jsx-preview, inline-citation, sources, package-info, open-in-chat,
persona, queue, model-selector. The last one is deliberate: the existing
`ComposerControls` pills dispatch real backend commands and revert optimistically
on an error frame, which the registry component does not do.

## Component mapping

| AI Elements | Replaces | Notes |
|---|---|---|
| `Conversation` / `ConversationContent` / `ConversationScrollButton` / `ConversationEmptyState` | `scrollAnchoring.ts`, the `followRef` + `handleScroll` + scroll effect in `AgentChatPane`, and the `PaneMessage` empty state | `use-stick-to-bottom` subsumes the re-arm band logic; **delete `scrollAnchoring.ts` and its test** |
| `Message` / `MessageContent` / `MessageResponse` | `MessageBubble` | `MessageResponse` is Streamdown — markdown, fenced code, tables, math, mermaid |
| `Reasoning` / `ReasoningTrigger` / `ReasoningContent` | `ReasoningBlock` | keeps the collapsed-by-default behaviour |
| `Tool` / `ToolHeader` / `ToolContent` / `ToolInput` | `ToolRow` | `ToolInput` renders the `detail` JSON the reducer starts keeping |
| `Task` / `TaskTrigger` / `TaskContent` | `ToolGroup` | fed by the existing `collapseWorkLog` split |
| `PromptInput` + `Body` / `Textarea` / `Footer` / `Tools` / `Submit` | `ChatComposer` | Enter-to-send and steer-while-running must be preserved (see below) |
| `PromptInputSelect` / `PromptInputActionMenu` | `ComposerControls` inline/menu variants + the `TabStripPopoverMenu` overflow copy | the dual-render container-query hack can go — `PromptInputTools` handles overflow |
| `Context` | *new* | token / context-window meter, fed by `TurnCompletedPayload.Usage` |

`ChatHeader` and `ChatStatusStrip` stay as they are. `timeline.ts` stays — it is
pure, tested, and AI Elements has no grouping logic of its own.

### Behaviour that must survive the swap

- **Enter sends, Shift+Enter newlines.**
- **Send is never gated on `status === 'running'`.** The backend decider
  explicitly allows a follow-up message to steer an in-flight turn; disabling the
  button would silently reject something the backend supports. `PromptInputSubmit`
  defaults to a stop button while streaming — it must be configured to keep
  submit reachable, with the interrupt action kept alongside it.
- **Reconnect does not blank the timeline.** `showConnecting` gates only on
  `status === 'connecting' && items.length === 0`.
- **The gap marker.** `view.hasGap` still renders its "some updates may be
  missing" chip.

## Data model changes

Four additive fields. All are already on the wire and currently discarded.

```ts
// types.ts
interface ChatItem {
  // …existing
  toolCallId?: string   // detail.toolCallId on item.started
  input?: unknown       // detail on item.completed (the tool's parsed input JSON)
  createdAt: number     // AgentEvent.createdAt
}

interface AgentThreadView {
  // …existing
  usage?: {             // TurnCompletedPayload.Usage
    inputTokens: number
    outputTokens: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    contextWindow?: number
  }
}
```

`createdAt` retires `useTurnTimings`. That hook exists only because `ChatItem`
carried no timestamp; it reads `Date.now()` during render and is documented as
"approximate after a reconnect that replays a whole historical thread". With a
real event timestamp, `formatTurnStamp` consumes `createdAt` directly and the
ref-cache and its caveat both disappear.

`adapter.ts` (new, pure, unit-tested) maps `TimelineEntry[]` onto AI Elements
props. `eventReducer.ts` keeps its existing shape — `applyForwarded` gains the
`detail` passthrough, `reduceAgentEvents` gains a `thread.turn.completed` branch
for `usage`.

## Palette A

`globals.css` only. No component file outside `src/features/agent-chat/` is
edited for color.

```css
/* new surface tokens — an elevation ladder above --devdeck-pane */
--devdeck-base:     #131616;                /* backdrop behind panes */
--devdeck-raised:   #212525;                /* code blocks, tool cards, composer */
--devdeck-card:     #262b2b;                /* code-block title bar, hover-on-raised */
--devdeck-hairline: rgba(255, 255, 255, 0.08);

/* unchanged: --devdeck-pane #1a1d1d, --devdeck-accent #39c6bd, --devdeck-fg,
   --devdeck-fg-2, --devdeck-run/wait/err, every border and tint alias */

/* shadcn semantics re-pointed — 0 existing call sites, so this is inert
   for every component outside src/components/{shadcn,ai-elements}/ */
--muted:     var(--devdeck-raised);   /* was --devdeck-pane: bg-muted was invisible */
--card:      var(--devdeck-raised);
--secondary: var(--devdeck-card);
--accent:    var(--devdeck-card);     /* was --devdeck-on (20% white) — too hot for hover */
--border:    var(--devdeck-hairline); /* was #7d8180 — hard-outlined every card */
```

Each new token is registered in `@theme inline` as `--color-devdeck-*`, matching
the existing convention.

Contrast on the new surfaces: `--devdeck-fg` (`#f2f5f4`) on `--devdeck-raised`
(`#212525`) ≈ 10.4:1; `--devdeck-fg-2` (`#9ca09f`) on the same ≈ 4.3:1 — above
AA for body text and for the recessive chrome respectively. Radius keeps the
three existing steps; AI Elements' `rounded-lg` resolves through `--radius`,
which already points at `--r-control`.

## Non-goals

**`ToolOutput` stays empty.** `grep -r "tool_result" backend/internal/` returns
nothing — the Claude provider parses `tool_use` blocks but never the
`tool_result` blocks that carry results. Tool cards render name + input +
status. Wiring results is a provider-parser change, not a UI change.

**`Confirmation` (Allow / Deny) is not wired.** `ReqCommandExecApproval` and
friends exist in the event taxonomy (`event.go:102-107`) but
`useAgentChatSocket` handles no `request.opened` frame, so `approval-required`
mode has no UI today. Separate feature; the vendored component is not installed
until it has a data source.

**No light theme.** Design stays dark-only.

**No app-wide restyle.** Only the chat pane consumes the new surface tokens in
this spec.

## Testing

- **Delete** `scrollAnchoring.ts` + `scrollAnchoring.test.ts` — `Conversation`
  owns follow-mode.
- **Extend** `eventReducer.test.ts`: `detail` is captured as `input` and
  `toolCallId`; `createdAt` is folded from the event; a `thread.turn.completed`
  frame populates `usage`; the replay-overlap and gap-detection cases still pass
  unchanged.
- **New** `adapter.test.ts`: `TimelineEntry[]` → component props, including a
  tool entry with malformed (non-JSON) `detail`.
- **Rewrite** `AgentChatPane.test.tsx`, `ChatComposer.test.tsx`,
  `ComposerControls.test.tsx` — the DOM changes, so the selectors do. Each keeps
  its existing assertions: loading / error / empty states, Enter-vs-Shift+Enter,
  send-while-running, and optimistic revert on an error frame.
- **Keep** `timeline.test.ts` untouched. If it needs edits, the grouping
  contract was broken by accident.
- `npm run typecheck` and `npm run build` must pass; `vitest run` green.

## Risks

**`lucide-react` major mismatch.** The repo pins `^1.22.0`; AI Elements is
developed against `0.5xx`, and lucide 1.0 removed deprecated icon aliases. A
vendored file importing a renamed icon fails at typecheck. Verify on the first
install and fix imports in place — this is exactly the kind of drift that
vendoring makes cheap to repair.

**Bundle weight.** `shiki` plus `streamdown` and its four plugins is the largest
single addition in the app's history. Measure `npm run build` output before and
after; if `code-block` dominates, load it through `React.lazy`.

**Two primitive libraries diverge on focus behaviour.** Radix popovers
(`prompt-input`'s action menu) and base-ui popovers (the rest of the app) differ
in focus-trap and Escape semantics. Accepted; noted so a keyboard bug in the
composer is not mistaken for a regression elsewhere.

**`shadcn add` overwriting `globals.css`.** The CLI can rewrite the Tailwind
entry when it thinks tokens are missing. `components.json` is written by hand and
`git diff src/styles/globals.css` is checked after every `add`.

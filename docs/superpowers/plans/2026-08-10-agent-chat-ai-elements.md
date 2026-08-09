# Agent Chat — AI Elements Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hand-rolled agent-chat surface with vendored AI Elements components (markdown rendering, syntax-highlighted code, collapsible reasoning, tool cards with real arguments, a proper prompt input) and add the elevation color tokens those components need.

**Architecture:** AI Elements is vendored as source via the shadcn CLI into `src/components/ai-elements/`, with its Radix primitives isolated in `src/components/shadcn/` so the existing `@base-ui/react` components in `src/components/ui/` are never overwritten. The components are presentational; a new pure `adapter.ts` maps the existing `AgentThreadView` / `TimelineEntry` model onto their props. The WebSocket transport, the event reducer's shape, and `timeline.ts`'s grouping are unchanged.

**Tech Stack:** React 19, Vite 8, Tailwind v4, vitest + @testing-library/react, AI Elements (shadcn registry), Radix UI, Streamdown, Shiki, use-stick-to-bottom.

**Spec:** `docs/superpowers/specs/2026-08-09-agent-chat-ai-elements-design.md`

## Global Constraints

These apply to **every** task. Each task's requirements implicitly include this section.

- **Working directory is `frontend/`** for all npm and vitest commands.
- **New test files do not run unless registered.** `frontend/vite.config.ts` has an explicit `test.include` allowlist (~83 entries, agent-chat block at lines 142-149). A test file not added there silently never executes. Every task that creates a test file MUST add its path to that array.
- **The pre-commit hook typechecks the whole project and HEAD already fails it.** Four pre-existing `TS6133` unused-symbol errors live in `src/features/layout/Header.tsx` (3) and `src/routes/w.$wsId.tsx` (1). Commit with `git commit --no-verify`. **Do not "fix" those two files** — they are unrelated in-progress work owned by the user.
- **Never edit vendored files** under `src/components/ai-elements/` or `src/components/shadcn/` after Task 1. Customize by passing `className` from our own components. The only exception is Task 1's own lucide icon-rename repairs.
- **Never edit** `src/routeTree.gen.ts` (generated), `src/store/types.ts`, `src/store/useDevDeckStore.ts`, `backend/internal/domain/models.go`.
- Imports use the `@/*` alias — never a relative path into `src/`. `verbatimModuleSyntax` is on: type-only imports MUST use `import type`.
- `cn()` from `@/lib/utils` for className merging. Icons from `lucide-react` only. Design is dark-only; colors come from the tokens in `src/styles/globals.css`.
- Verification per task: `npx vitest run <the task's test files>` then `npm run typecheck`. Both must pass before commit.
- No backend changes in this plan. The Go event pipeline is untouched.

---

### Task 1: Vendor AI Elements and its Radix primitives

**Files:**
- Create: `frontend/components.json`
- Create: `frontend/src/components/ai-elements/*.tsx` (written by the CLI)
- Create: `frontend/src/components/shadcn/*.tsx` (written by the CLI)
- Create: `frontend/src/components/ai-elements/vendored.smoke.test.tsx`
- Modify: `frontend/package.json` (deps added by the CLI + one explicit install)
- Modify: `frontend/vite.config.ts` (test.include)

**Interfaces:**
- Consumes: nothing.
- Produces: the module `@/components/ai-elements/conversation` exporting `Conversation`, `ConversationContent`, `ConversationEmptyState`, `ConversationScrollButton`; `@/components/ai-elements/message` exporting `Message`, `MessageContent`, `MessageResponse`; `@/components/ai-elements/reasoning` exporting `Reasoning`, `ReasoningTrigger`, `ReasoningContent`; `@/components/ai-elements/tool` exporting `Tool`, `ToolHeader`, `ToolContent`, `ToolInput` and the type `ToolPart`; `@/components/ai-elements/task` exporting `Task`, `TaskTrigger`, `TaskContent`, `TaskItem`; `@/components/ai-elements/prompt-input` exporting `PromptInput`, `PromptInputBody`, `PromptInputTextarea`, `PromptInputFooter`, `PromptInputTools`, `PromptInputSubmit` and the interface `PromptInputMessage { text: string; files: FileUIPart[] }`; `@/components/ai-elements/code-block` exporting `CodeBlock`, `CodeBlockCopyButton`.

- [ ] **Step 1: Write the failing smoke test**

Create `frontend/src/components/ai-elements/vendored.smoke.test.tsx`:

```tsx
/**
 * Guards the vendored surface. These are copy-in files, not an npm package —
 * a re-vendor that renames or drops an export breaks the chat pane at build
 * time with no upstream version bump to blame. Asserting the exports exist
 * (not how they render) keeps this cheap and stable.
 */
import { describe, expect, it } from 'vitest'
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Tool, ToolContent, ToolHeader, ToolInput } from '@/components/ai-elements/tool'
import { Task, TaskContent, TaskTrigger } from '@/components/ai-elements/task'
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from '@/components/ai-elements/prompt-input'
import { CodeBlock, CodeBlockCopyButton } from '@/components/ai-elements/code-block'

describe('vendored AI Elements surface', () => {
  it.each([
    ['Conversation', Conversation],
    ['ConversationContent', ConversationContent],
    ['ConversationEmptyState', ConversationEmptyState],
    ['ConversationScrollButton', ConversationScrollButton],
    ['Message', Message],
    ['MessageContent', MessageContent],
    ['MessageResponse', MessageResponse],
    ['Reasoning', Reasoning],
    ['ReasoningTrigger', ReasoningTrigger],
    ['ReasoningContent', ReasoningContent],
    ['Tool', Tool],
    ['ToolHeader', ToolHeader],
    ['ToolContent', ToolContent],
    ['ToolInput', ToolInput],
    ['Task', Task],
    ['TaskTrigger', TaskTrigger],
    ['TaskContent', TaskContent],
    ['PromptInput', PromptInput],
    ['PromptInputBody', PromptInputBody],
    ['PromptInputTextarea', PromptInputTextarea],
    ['PromptInputFooter', PromptInputFooter],
    ['PromptInputTools', PromptInputTools],
    ['PromptInputSubmit', PromptInputSubmit],
    ['CodeBlock', CodeBlock],
    ['CodeBlockCopyButton', CodeBlockCopyButton],
  ])('exports %s as a component', (_name, component) => {
    expect(component).toBeDefined()
  })
})
```

- [ ] **Step 2: Register the test file**

In `frontend/vite.config.ts`, inside the `test.include` array, immediately after the line `'src/components/ui/dialog.test.tsx',` add:

```ts
      'src/components/ai-elements/vendored.smoke.test.tsx',
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/components/ai-elements/vendored.smoke.test.tsx`
Expected: FAIL — `Failed to resolve import "@/components/ai-elements/conversation"`.

- [ ] **Step 4: Write `frontend/components.json` by hand**

Do **not** run `shadcn init` — it rewrites `src/styles/globals.css` and `tsconfig.json`. Create `frontend/components.json` with exactly this content:

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": false,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/styles/globals.css",
    "baseColor": "neutral",
    "cssVariables": true,
    "prefix": ""
  },
  "iconLibrary": "lucide",
  "aliases": {
    "components": "@/components",
    "ui": "@/components/shadcn",
    "utils": "@/lib/utils",
    "lib": "@/lib",
    "hooks": "@/hooks"
  }
}
```

`aliases.ui` pointing at `@/components/shadcn` is the load-bearing line. `src/components/ui/` already contains base-ui `button.tsx`, `select.tsx`, `tooltip.tsx`, `input.tsx`, `switch.tsx`, and `textarea.tsx`; pointing the CLI there would overwrite them and break the rest of the app.

- [ ] **Step 5: Vendor the seven components**

Run, from `frontend/`:

```bash
npx shadcn@4.16.2 add --yes \
  https://elements.ai-sdk.dev/api/registry/conversation.json \
  https://elements.ai-sdk.dev/api/registry/message.json \
  https://elements.ai-sdk.dev/api/registry/reasoning.json \
  https://elements.ai-sdk.dev/api/registry/tool.json \
  https://elements.ai-sdk.dev/api/registry/task.json \
  https://elements.ai-sdk.dev/api/registry/code-block.json \
  https://elements.ai-sdk.dev/api/registry/prompt-input.json
```

Do **not** use `registry/all.json` — it pulls `@xyflow/react`, `media-chrome`, and `@rive-app/react-webgl2` for canvas and audio components this app has no use for.

The registry items declare `target: components/ai-elements/<name>.tsx`, so they land in `src/components/ai-elements/`. Their Radix dependencies (accordion, alert, avatar, badge, button, button-group, card, collapsible, command, dropdown-menu, hover-card, input-group, progress, scroll-area, select, separator, spinner, tooltip, plus the `shimmer` AI Element) land in `src/components/shadcn/`.

- [ ] **Step 6: Verify the CLI did not touch the token layer**

Run: `git diff --stat src/styles/globals.css tsconfig.json`
Expected: no output. If either file changed, revert it with `git checkout -- <file>` — Task 2 owns `globals.css`.

- [ ] **Step 7: Install the runtime dependencies**

The CLI installs each registry item's declared deps. Confirm and top up:

```bash
npm install ai streamdown shiki use-stick-to-bottom nanoid \
  @streamdown/cjk @streamdown/code @streamdown/math @streamdown/mermaid \
  @radix-ui/react-use-controllable-state
```

- [ ] **Step 8: Run the smoke test to verify it passes**

Run: `cd frontend && npx vitest run src/components/ai-elements/vendored.smoke.test.tsx`
Expected: PASS, 25 assertions.

- [ ] **Step 9: Typecheck and repair lucide icon renames**

Run: `cd frontend && npm run typecheck`

This repo pins `lucide-react@^1.22.0`; AI Elements is developed against `0.5xx`, and lucide 1.0 removed deprecated icon aliases. If typecheck reports a missing icon export from `lucide-react` inside a vendored file, open that file and replace the import with the current name (e.g. a removed `XIcon` alias becomes `X`). This is the one sanctioned edit to vendored source — record each rename in the commit message.

Expected after repairs: only the four pre-existing `Header.tsx` / `w.$wsId.tsx` `TS6133` errors listed in Global Constraints remain.

- [ ] **Step 10: Commit**

```bash
git add frontend/components.json frontend/src/components/ai-elements frontend/src/components/shadcn frontend/package.json frontend/package-lock.json frontend/vite.config.ts
git commit --no-verify -m "feat(agent-chat): vendor AI Elements + Radix primitives

shadcn CLI writes to @/components/shadcn so the base-ui components/ui/*
files are untouched. Seven registry items, not registry/all.json."
```

---

### Task 2: Palette A elevation tokens

**Files:**
- Modify: `frontend/src/styles/globals.css`
- Test: `frontend/src/styles/globals.tokens.test.ts` (exists — extend it)

**Interfaces:**
- Consumes: nothing.
- Produces: CSS custom properties `--devdeck-base`, `--devdeck-raised`, `--devdeck-card`, `--devdeck-hairline`, and the Tailwind utilities `bg-devdeck-base`, `bg-devdeck-raised`, `bg-devdeck-card`, `border-devdeck-hairline`. Re-points `--muted`, `--card`, `--secondary`, `--accent`, `--border`. Defines the `is-user` custom variant.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/styles/globals.tokens.test.ts`, inside the existing `describe('globals.css token layer', ...)` block:

```ts
  it('defines the Palette A elevation ladder', () => {
    expect(css).toContain('--devdeck-base: #131616')
    expect(css).toContain('--devdeck-pane: #1a1d1d')
    expect(css).toContain('--devdeck-raised: #212525')
    expect(css).toContain('--devdeck-card: #262b2b')
    expect(css).toContain('--devdeck-hairline: rgba(255, 255, 255, 0.08)')
  })

  it('exposes the new surfaces as Tailwind color utilities', () => {
    expect(css).toContain('--color-devdeck-base: var(--devdeck-base)')
    expect(css).toContain('--color-devdeck-raised: var(--devdeck-raised)')
    expect(css).toContain('--color-devdeck-card: var(--devdeck-card)')
    expect(css).toContain('--color-devdeck-hairline: var(--devdeck-hairline)')
  })

  // The vendored AI Elements components style themselves through the shadcn
  // semantic layer. Two of those tokens were aliases of --background, which
  // made `bg-muted` invisible and `border-border` a hard 3:1 outline on every
  // card. Nothing outside src/components/{shadcn,ai-elements} reads them —
  // `border-border` and `bg-muted` have zero call sites — so re-pointing them
  // is inert for the rest of the app.
  it('gives the shadcn semantic layer distinct surfaces', () => {
    expect(css).toContain('--muted: var(--devdeck-raised)')
    expect(css).toContain('--card: var(--devdeck-raised)')
    expect(css).toContain('--secondary: var(--devdeck-card)')
    expect(css).toContain('--accent: var(--devdeck-card)')
    expect(css).toContain('--border: var(--devdeck-hairline)')
  })

  it('does not alias --muted to the pane again', () => {
    expect(css).not.toContain('--muted: var(--devdeck-pane)')
  })

  // message.tsx styles the user bubble with `is-user:dark` and
  // `group-[.is-user]:…`. Without the custom variant registered, Tailwind
  // emits no rule for the `is-user:` prefix and the bubble silently loses its
  // treatment.
  it('registers the is-user variant the Message component relies on', () => {
    expect(css).toContain('@custom-variant is-user')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && npx vitest run src/styles/globals.tokens.test.ts`
Expected: FAIL — the five new `it` blocks fail on the missing tokens; the pre-existing blocks still pass.

- [ ] **Step 3: Add the surface tokens**

In `frontend/src/styles/globals.css`, in the `:root` block immediately after the `--devdeck-pane: #1a1d1d;` line (currently line 43), insert:

```css
  /* Elevation ladder. One pane colour cannot separate a code block from a
     tool card from the message flow behind them, which is what the chat pane
     needs; these three are that separation. Same neutral temperature as every
     other surface (hue 188.6deg, matching the accent) — see the note above. */
  --devdeck-base: #131616; /* backdrop behind panes */
  --devdeck-raised: #212525; /* code blocks, tool cards, composer box */
  --devdeck-card: #262b2b; /* code-block title bar, hover on raised */
  /* Card and separator edge for the vendored component layer. --devdeck-line
     (#7d8180) stays what it is — an edge that must be SEEN, on inputs and
     real separators. A 3:1 line around every card is not that. */
  --devdeck-hairline: rgba(255, 255, 255, 0.08);
```

- [ ] **Step 4: Re-point the shadcn semantic tokens**

In the same file, in the `/* ── semantic (shadcn-style) ── */` block (currently lines 125-147), replace these five declarations:

```css
  --card: var(--devdeck-raised);
  --secondary: var(--devdeck-card);
  --muted: var(--devdeck-raised);
  --accent: var(--devdeck-card);
  --border: var(--devdeck-hairline);
```

Leave `--background`, `--foreground`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary-foreground`, `--muted-foreground`, `--accent-foreground`, `--destructive`, `--destructive-foreground`, `--input`, `--ring`, and `--radius` exactly as they are.

- [ ] **Step 5: Register the Tailwind utilities**

In the `@theme inline` block, in the raw-palette section after `--color-devdeck-pane: var(--devdeck-pane);` (currently line 200), insert:

```css
  --color-devdeck-base: var(--devdeck-base);
  --color-devdeck-raised: var(--devdeck-raised);
  --color-devdeck-card: var(--devdeck-card);
  --color-devdeck-hairline: var(--devdeck-hairline);
```

- [ ] **Step 6: Register the `is-user` variant**

Immediately after the existing `@custom-variant dark (&:is(.dark *));` line (line 5), add:

```css
/* message.tsx marks a user turn with `.is-user` on the Message wrapper and
   styles its bubble through `is-user:` and `group-[.is-user]:` prefixes.
   Tailwind needs the variant declared or the `is-user:` rules never emit. */
@custom-variant is-user (&:is(.is-user *));
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd frontend && npx vitest run src/styles/globals.tokens.test.ts`
Expected: PASS, all blocks.

- [ ] **Step 8: Confirm the build still compiles the CSS**

Run: `cd frontend && npm run build`
Expected: build succeeds. A malformed `@custom-variant` fails the Tailwind plugin loudly here, which is the point of running it.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/styles/globals.css frontend/src/styles/globals.tokens.test.ts
git commit --no-verify -m "feat(theme): Palette A elevation ladder + shadcn semantic surfaces

Adds --devdeck-base/raised/card/hairline and re-points --muted/--card/
--secondary/--accent/--border, which were aliases of --background and
--devdeck-line. Zero call sites outside the vendored component layer."
```

---

### Task 3: Reducer keeps the tool arguments and event timestamps it currently drops

**Files:**
- Modify: `frontend/src/features/agent-chat/types.ts`
- Modify: `frontend/src/features/agent-chat/eventReducer.ts`
- Test: `frontend/src/features/agent-chat/eventReducer.test.ts` (exists — extend it)

**Interfaces:**
- Consumes: nothing.
- Produces: `ChatItem` gains `toolCallId?: string`, `input?: unknown`, `createdAt?: number`.

`createdAt` is **optional on purpose**: `timeline.test.ts` builds `ChatItem` literals and must keep compiling untouched. The reducer always sets it, so it is never actually absent in production.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/features/agent-chat/eventReducer.test.ts`:

```ts
describe('reduceAgentEvents — tool detail and timestamps', () => {
  /** A forwarded provider `item.started` for a tool call. The outer event is
   *  an orchestration `thread.activity-appended`; the provider's own envelope
   *  rides in its payload. See applyForwarded's doc comment. */
  function toolStarted(seq: number, itemId: string, name: string): AgentEvent {
    return {
      seq,
      eventId: `e-${seq}`,
      type: 'thread.activity-appended',
      threadId: 't-1',
      commandId: `c-${seq}`,
      createdAt: 1_700_000_000_000 + seq * 1000,
      payload: {
        type: 'item.started',
        itemId,
        payload: { itemType: 'tool_call', title: name, detail: { toolCallId: 'tc_42', name } },
      },
    }
  }

  function toolCompleted(seq: number, itemId: string, input: unknown): AgentEvent {
    return {
      seq,
      eventId: `e-${seq}`,
      type: 'thread.activity-appended',
      threadId: 't-1',
      commandId: `c-${seq}`,
      createdAt: 1_700_000_000_000 + seq * 1000,
      payload: {
        type: 'item.completed',
        itemId,
        payload: { itemType: 'tool_call', status: 'completed', detail: input },
      },
    }
  }

  it('keeps the toolCallId from the started event', () => {
    const view = reduceAgentEvents(emptyThreadView(), [toolStarted(1, 'i-1', 'Edit')])
    expect(view.items[0].toolCallId).toBe('tc_42')
  })

  it('keeps the tool input from the completed event', () => {
    const started = reduceAgentEvents(emptyThreadView(), [toolStarted(1, 'i-1', 'Edit')])
    const view = reduceAgentEvents(started, [toolCompleted(2, 'i-1', { file_path: '/a/b.go' })])
    expect(view.items).toHaveLength(1)
    expect(view.items[0].input).toEqual({ file_path: '/a/b.go' })
    expect(view.items[0].status).toBe('done')
  })

  it('does not clobber an input already folded in when a later event carries none', () => {
    const withInput = reduceAgentEvents(emptyThreadView(), [
      toolStarted(1, 'i-1', 'Edit'),
      toolCompleted(2, 'i-1', { file_path: '/a/b.go' }),
    ])
    const view = reduceAgentEvents(withInput, [
      {
        seq: 3,
        eventId: 'e-3',
        type: 'thread.activity-appended',
        threadId: 't-1',
        commandId: 'c-3',
        createdAt: 1_700_000_003_000,
        payload: { type: 'item.completed', itemId: 'i-1', payload: { itemType: 'tool_call', status: 'completed' } },
      },
    ])
    expect(view.items[0].input).toEqual({ file_path: '/a/b.go' })
  })

  it('stamps every item with the event createdAt', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      {
        seq: 1,
        eventId: 'e-1',
        type: 'thread.message-sent',
        threadId: 't-1',
        commandId: 'c-1',
        createdAt: 1_700_000_000_000,
        payload: { text: 'hello' },
      },
      toolStarted(2, 'i-1', 'Read'),
    ])
    expect(view.items[0].createdAt).toBe(1_700_000_000_000)
    expect(view.items[1].createdAt).toBe(1_700_000_002_000)
  })

  it('stamps an assistant delta item with the createdAt of its first chunk', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      {
        seq: 1,
        eventId: 'e-1',
        type: 'thread.activity-appended',
        threadId: 't-1',
        commandId: 'c-1',
        createdAt: 1_700_000_005_000,
        payload: { itemId: 'a-1', stream: 'text', text: 'partial', sequence: 1 },
      },
      {
        seq: 2,
        eventId: 'e-2',
        type: 'thread.activity-appended',
        threadId: 't-1',
        commandId: 'c-2',
        createdAt: 1_700_000_009_000,
        payload: { itemId: 'a-1', stream: 'text', text: ' more', sequence: 2 },
      },
    ])
    expect(view.items).toHaveLength(1)
    expect(view.items[0].text).toBe('partial more')
    expect(view.items[0].createdAt).toBe(1_700_000_005_000)
  })

  it('records an error row with its timestamp', () => {
    const view = reduceAgentEvents(emptyThreadView(), [
      {
        seq: 1,
        eventId: 'e-1',
        type: 'thread.activity-appended',
        threadId: 't-1',
        commandId: 'c-1',
        createdAt: 1_700_000_011_000,
        payload: { type: 'runtime.error', payload: { message: 'claude exited 1' } },
      },
    ])
    expect(view.items[0].kind).toBe('error')
    expect(view.items[0].createdAt).toBe(1_700_000_011_000)
  })
})
```

If `AgentEvent` is not already imported in this test file, add it to the existing `import type` line from `@/features/agent-chat/types`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/agent-chat/eventReducer.test.ts`
Expected: FAIL — the six new tests fail on `undefined` for `toolCallId`, `input`, and `createdAt`. Every pre-existing test in the file still passes.

- [ ] **Step 3: Extend the `ChatItem` type**

In `frontend/src/features/agent-chat/types.ts`, replace the `ChatItem` interface with:

```ts
export interface ChatItem {
  id: string
  kind: ChatItemKind
  text: string
  /** Tool rows only; read-only in this spec — Allow/Deny arrives with approvals. */
  toolName?: string
  status?: 'running' | 'done' | 'failed'
  /** Tool rows only. The provider's own call id, from `item.started`'s
   *  `detail.toolCallId`. Carried so a future approvals feature can correlate
   *  a decision back to the call that asked for it. */
  toolCallId?: string
  /** Tool rows only. The tool's arguments, from `item.completed`'s `detail` —
   *  the accumulated `input_json_delta` the provider streams. Rendered by
   *  `ToolInput`. `unknown` because the shape is per-tool and must never be
   *  interpreted here. */
  input?: unknown
  /** Wall-clock of the event that CREATED this item (later deltas folded into
   *  it do not move it). Optional only so existing `ChatItem` fixtures keep
   *  compiling — the reducer always sets it. */
  createdAt?: number
  /** Highest delta sequence folded into this item, per stream. */
  lastSequence: number
}
```

- [ ] **Step 4: Thread `createdAt` and `detail` through the reducer**

In `frontend/src/features/agent-chat/eventReducer.ts`:

**4a.** Widen the forwarded-envelope type. Replace the `ForwardedProviderEvent` interface with:

```ts
interface ForwardedProviderEvent {
  type: string
  itemId?: string
  payload?: {
    itemType?: string
    title?: string
    status?: string
    message?: string
    /** `ItemStartedPayload.Detail` / `ItemCompletedPayload.Detail` — an opaque
     *  `json.RawMessage` on the wire. On `item.started` it is
     *  `{toolCallId, name}`; on `item.completed` it is the tool's own input
     *  JSON. Never interpreted here beyond picking out `toolCallId`. */
    detail?: unknown
  }
}
```

**4b.** Give `applyDelta` and `applyForwarded` the timestamp. Change their signatures and the two call sites:

```ts
function applyDelta(items: ChatItem[], payload: ActivityAppendedPayload, createdAt: number): { items: ChatItem[]; gap: boolean } {
```

and inside its `idx === -1` branch, add `createdAt` to the new item literal:

```ts
    const item: ChatItem = {
      id: payload.itemId,
      kind: itemKindForStream(payload.stream),
      text: payload.text,
      createdAt,
      lastSequence: payload.sequence,
    }
```

The `existing` branch is unchanged — a delta folded into an item must not move that item's creation stamp.

**4c.** Rewrite `applyForwarded` to keep the detail:

```ts
/** Reads `detail.toolCallId` without interpreting the rest of the payload.
 *  `detail` is whatever the provider sent — an object on `item.started`, the
 *  tool's own arguments on `item.completed`, or absent. */
function toolCallIdOf(detail: unknown): string | undefined {
  if (typeof detail !== 'object' || detail === null) return undefined
  const id = (detail as Record<string, unknown>).toolCallId
  return typeof id === 'string' ? id : undefined
}

function applyForwarded(items: ChatItem[], eventId: string, ev: ForwardedProviderEvent, createdAt: number): ChatItem[] {
  const inner = ev.payload ?? {}

  if (ev.type === 'runtime.error' || inner.itemType === 'error') {
    const text = inner.message ?? inner.title ?? 'The agent reported an error.'
    return [...items, { id: eventId, kind: 'error', text, createdAt, lastSequence: 0 }]
  }

  if (inner.itemType !== 'tool_call') return items

  const id = ev.itemId ?? eventId
  const idx = items.findIndex((item) => item.id === id)
  const started = ev.type !== 'item.completed'
  // On `item.started` the detail is the {toolCallId, name} envelope, not the
  // tool's arguments; only `item.completed` carries the real input.
  const input = started ? undefined : inner.detail

  if (idx === -1) {
    return [
      ...items,
      {
        id,
        kind: 'tool',
        text: inner.title ?? '',
        toolName: inner.title ?? 'Tool',
        status: started ? 'running' : inner.status === 'failed' ? 'failed' : 'done',
        toolCallId: toolCallIdOf(inner.detail),
        ...(input === undefined ? {} : { input }),
        createdAt,
        lastSequence: 0,
      },
    ]
  }

  const next = items.slice()
  next[idx] = {
    ...items[idx],
    ...(inner.title ? { toolName: inner.title } : {}),
    // A replayed tail can re-deliver an event that carries no detail. Keeping
    // the existing value is what makes reattach idempotent for this field.
    ...(toolCallIdOf(inner.detail) === undefined ? {} : { toolCallId: toolCallIdOf(inner.detail) }),
    ...(input === undefined ? {} : { input }),
    status: started ? items[idx].status : inner.status === 'failed' ? 'failed' : 'done',
  }
  return next
}
```

**4d.** In `reduceAgentEvents`, pass `event.createdAt` down and stamp the user message:

```ts
    if (event.type === 'thread.message-sent' && isMessageSentPayload(event.payload)) {
      items = [...items, { id: event.eventId, kind: 'user', text: event.payload.text, createdAt: event.createdAt, lastSequence: 0 }]
    } else if (isActivityAppendedPayload(event.payload)) {
      const result = applyDelta(items, event.payload, event.createdAt)
      items = result.items
      hasGap = hasGap || result.gap
    } else if (isForwardedProviderEvent(event.payload)) {
      items = applyForwarded(items, event.eventId, event.payload, event.createdAt)
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/agent-chat/eventReducer.test.ts src/features/agent-chat/timeline.test.ts`
Expected: PASS for both files. `timeline.test.ts` must pass with **no edits** — if it does not compile, `createdAt` was made required instead of optional.

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: only the four pre-existing `Header.tsx` / `w.$wsId.tsx` errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/agent-chat/types.ts frontend/src/features/agent-chat/eventReducer.ts frontend/src/features/agent-chat/eventReducer.test.ts
git commit --no-verify -m "feat(agent-chat): keep tool detail and event timestamps in the read model

parse.go already sends {toolCallId, name} on item.started and the tool's
input JSON on item.completed; applyForwarded discarded both. createdAt is
optional so existing ChatItem fixtures keep compiling."
```

---

### Task 4: `adapter.ts` — map the read model onto AI Elements props

**Files:**
- Create: `frontend/src/features/agent-chat/adapter.ts`
- Create: `frontend/src/features/agent-chat/adapter.test.ts`
- Modify: `frontend/vite.config.ts` (test.include)

**Interfaces:**
- Consumes: `ChatItem`, `AgentThreadView` from `@/features/agent-chat/types`; `TimelineEntry` from `@/features/agent-chat/timeline`; `ToolUIPart`, `ChatStatus` types from `ai`.
- Produces:
  - `messageRole(kind: ChatItem['kind']): 'user' | 'assistant'`
  - `toolUIType(toolName: string | undefined): \`tool-${string}\``
  - `toolUIState(status: ChatItem['status']): ToolUIPart['state']`
  - `promptChatStatus(view: AgentThreadView): ChatStatus`
  - `entryCreatedAt(entry: TimelineEntry): number | undefined`
  - `turnSpans(entries: TimelineEntry[]): TurnSpan[]` where `interface TurnSpan { key: string; firstEntryIndex: number; lastEntryIndex: number }`

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/features/agent-chat/adapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { entryCreatedAt, messageRole, promptChatStatus, toolUIState, toolUIType, turnSpans } from '@/features/agent-chat/adapter'
import { buildTimeline } from '@/features/agent-chat/timeline'
import { emptyThreadView } from '@/features/agent-chat/eventReducer'
import type { ChatItem } from '@/features/agent-chat/types'

function item(partial: Partial<ChatItem> & Pick<ChatItem, 'id' | 'kind'>): ChatItem {
  return { text: '', lastSequence: 0, ...partial }
}

describe('messageRole', () => {
  it('maps a user item to the user role', () => {
    expect(messageRole('user')).toBe('user')
  })

  it('maps everything else to assistant', () => {
    expect(messageRole('assistant')).toBe('assistant')
    expect(messageRole('reasoning')).toBe('assistant')
    expect(messageRole('tool')).toBe('assistant')
    expect(messageRole('error')).toBe('assistant')
  })
})

describe('toolUIType', () => {
  it('namespaces the tool name the way ToolHeader parses it back out', () => {
    expect(toolUIType('Edit')).toBe('tool-Edit')
  })

  it('falls back to a generic name when the provider sent none', () => {
    expect(toolUIType(undefined)).toBe('tool-Tool')
  })

  it('keeps a hyphenated tool name intact', () => {
    // ToolHeader derives the label with type.split('-').slice(1).join('-'),
    // so a hyphen inside the name survives the round trip.
    expect(toolUIType('web-search')).toBe('tool-web-search')
  })
})

describe('toolUIState', () => {
  // The badge labels these map to are "Pending" / "Running" / "Completed" /
  // "Error". This app never has a tool RESULT (the Claude provider does not
  // parse tool_result), so 'output-available' means "the call finished", and
  // no ToolOutput is ever rendered.
  it('maps a running tool to the Running badge state', () => {
    expect(toolUIState('running')).toBe('input-available')
  })

  it('maps a finished tool to the Completed badge state', () => {
    expect(toolUIState('done')).toBe('output-available')
  })

  it('maps a failed tool to the Error badge state', () => {
    expect(toolUIState('failed')).toBe('output-error')
  })

  it('maps an unknown status to the Pending badge state', () => {
    expect(toolUIState(undefined)).toBe('input-streaming')
  })
})

describe('promptChatStatus', () => {
  it('reports ready when the thread is idle', () => {
    expect(promptChatStatus({ ...emptyThreadView(), status: 'idle' })).toBe('ready')
  })

  it('reports streaming while a turn is in flight', () => {
    expect(promptChatStatus({ ...emptyThreadView(), status: 'running' })).toBe('streaming')
  })

  it('reports submitted while the agent waits on the user', () => {
    expect(promptChatStatus({ ...emptyThreadView(), status: 'waiting' })).toBe('submitted')
  })

  it('reports ready when the thread has stopped', () => {
    expect(promptChatStatus({ ...emptyThreadView(), status: 'stopped' })).toBe('ready')
  })

  it('reports error when the thread carries one, whatever its status', () => {
    expect(promptChatStatus({ ...emptyThreadView(), status: 'running', error: 'boom' })).toBe('error')
  })
})

describe('entryCreatedAt', () => {
  it('reads the stamp off a message entry', () => {
    const entries = buildTimeline({ ...emptyThreadView(), items: [item({ id: 'm1', kind: 'user', createdAt: 500 })] })
    expect(entryCreatedAt(entries[0])).toBe(500)
  })

  it('reads the first item stamp off a tool group', () => {
    const entries = buildTimeline({
      ...emptyThreadView(),
      items: [item({ id: 't1', kind: 'tool', createdAt: 700 }), item({ id: 't2', kind: 'tool', createdAt: 900 })],
    })
    expect(entries).toHaveLength(1)
    expect(entryCreatedAt(entries[0])).toBe(700)
  })

  it('returns undefined for an unstamped entry', () => {
    const entries = buildTimeline({ ...emptyThreadView(), items: [item({ id: 'm1', kind: 'user' })] })
    expect(entryCreatedAt(entries[0])).toBeUndefined()
  })
})

describe('turnSpans', () => {
  it('gives each turn a first and last entry index', () => {
    const entries = buildTimeline({
      ...emptyThreadView(),
      items: [
        item({ id: 'u1', kind: 'user', createdAt: 100 }),
        item({ id: 'a1', kind: 'assistant', createdAt: 200 }),
        item({ id: 'u2', kind: 'user', createdAt: 300 }),
        item({ id: 'a2', kind: 'assistant', createdAt: 400 }),
      ],
    })
    expect(turnSpans(entries)).toEqual([
      { key: 'u1', firstEntryIndex: 0, lastEntryIndex: 1 },
      { key: 'u2', firstEntryIndex: 2, lastEntryIndex: 3 },
    ])
  })

  it('covers a thread replayed with no leading user message', () => {
    const entries = buildTimeline({
      ...emptyThreadView(),
      items: [item({ id: 'a1', kind: 'assistant', createdAt: 100 }), item({ id: 'a2', kind: 'assistant', createdAt: 200 })],
    })
    expect(turnSpans(entries)).toEqual([{ key: 'a1', firstEntryIndex: 0, lastEntryIndex: 1 }])
  })

  it('returns nothing for an empty timeline', () => {
    expect(turnSpans([])).toEqual([])
  })
})
```

- [ ] **Step 2: Register the test file**

In `frontend/vite.config.ts`, in `test.include`, immediately after `'src/features/agent-chat/timeline.test.ts',` add:

```ts
      'src/features/agent-chat/adapter.test.ts',
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/agent-chat/adapter.test.ts`
Expected: FAIL — `Failed to resolve import "@/features/agent-chat/adapter"`.

- [ ] **Step 4: Write the adapter**

Create `frontend/src/features/agent-chat/adapter.ts`:

```ts
/**
 * Pure mapping from this app's read model (`AgentThreadView` / `ChatItem` /
 * `TimelineEntry`) onto the props the vendored AI Elements components expect.
 * No React, no rendering — everything here is a total function over plain
 * data, so the mapping is unit-tested rather than asserted through the DOM.
 *
 * It exists so the vendored files stay untouched. AI Elements is written
 * against the AI SDK's `UIMessage`/`ToolUIPart` shapes; this app is
 * event-sourced off a Go orchestration engine. Rather than reshape either
 * side, this module translates at the boundary.
 */
import type { ChatStatus, ToolUIPart } from 'ai'
import type { TimelineEntry } from '@/features/agent-chat/timeline'
import type { AgentThreadView, ChatItem } from '@/features/agent-chat/types'

/** `Message`'s `from` prop. Only the user's own turns are "user"; reasoning,
 *  tool rows, and errors are all things the assistant side produced. */
export function messageRole(kind: ChatItem['kind']): 'user' | 'assistant' {
  return kind === 'user' ? 'user' : 'assistant'
}

/** `ToolHeader`'s `type` prop. It derives the visible label back out with
 *  `type.split('-').slice(1).join('-')`, so the name round-trips including
 *  any hyphens of its own. */
export function toolUIType(toolName: string | undefined): `tool-${string}` {
  return `tool-${toolName && toolName.length > 0 ? toolName : 'Tool'}`
}

/**
 * `ToolHeader`'s `state` prop, which picks the status badge:
 * `input-streaming` → "Pending", `input-available` → "Running",
 * `output-available` → "Completed", `output-error` → "Error".
 *
 * `output-available` here means "the call completed", not "a result is
 * available" — the Claude provider never parses `tool_result`, so this app has
 * no tool output to show and never renders `ToolOutput`. "Completed" is still
 * the honest badge for a finished call.
 */
export function toolUIState(status: ChatItem['status']): ToolUIPart['state'] {
  switch (status) {
    case 'running':
      return 'input-available'
    case 'done':
      return 'output-available'
    case 'failed':
      return 'output-error'
    default:
      return 'input-streaming'
  }
}

/**
 * `PromptInputSubmit`'s `status` prop. It renders a stop button (and a
 * `type="button"`, not `type="submit"`) whenever this is `submitted` or
 * `streaming` — which is exactly the interrupt affordance this composer wants.
 * Enter still steers an in-flight turn, because `PromptInputTextarea` calls
 * `form.requestSubmit()` directly rather than clicking the submit button.
 */
export function promptChatStatus(view: AgentThreadView): ChatStatus {
  if (view.error !== null) return 'error'
  switch (view.status) {
    case 'running':
      return 'streaming'
    case 'waiting':
      return 'submitted'
    default:
      return 'ready'
  }
}

/** When this entry came into being. A tool group is stamped by its earliest
 *  call, matching how the group reads on screen: one block, started once. */
export function entryCreatedAt(entry: TimelineEntry): number | undefined {
  if (entry.kind === 'tool-group') return entry.items[0]?.createdAt
  return entry.item.createdAt
}

export interface TurnSpan {
  /** Stable key — the leading user message's id, or the first entry's id for a
   *  thread replayed with no leading user message. */
  key: string
  firstEntryIndex: number
  lastEntryIndex: number
}

/**
 * Splits a timeline into turns, carrying BOTH ends of each turn.
 *
 * `timeline.ts`'s `turnBoundaries` returns only `lastEntryIndex`, which was
 * enough when the turn stamp was a wall-clock reading taken at render time.
 * Now that `ChatItem` carries `createdAt`, a stamp needs the turn's start too,
 * and deriving it here keeps `timeline.ts` and its tests untouched.
 */
export function turnSpans(entries: TimelineEntry[]): TurnSpan[] {
  const spans: TurnSpan[] = []

  entries.forEach((entry, index) => {
    const startsTurn = entry.kind === 'message' && entry.item.kind === 'user'
    if (startsTurn || spans.length === 0) {
      const key = entry.kind === 'tool-group' ? (entry.items[0]?.id ?? `turn-${index}`) : entry.item.id
      spans.push({ key, firstEntryIndex: index, lastEntryIndex: index })
      return
    }
    spans[spans.length - 1].lastEntryIndex = index
  })

  return spans
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/agent-chat/adapter.test.ts`
Expected: PASS, 19 tests.

- [ ] **Step 6: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: only the four pre-existing errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/agent-chat/adapter.ts frontend/src/features/agent-chat/adapter.test.ts frontend/vite.config.ts
git commit --no-verify -m "feat(agent-chat): pure adapter from the read model to AI Elements props"
```

---

### Task 5: Rewrite `MessagesTimeline` on Message / Reasoning / Tool / Task

**Files:**
- Modify: `frontend/src/features/agent-chat/MessagesTimeline.tsx` (full rewrite)
- Create: `frontend/src/features/agent-chat/MessagesTimeline.test.tsx`
- Modify: `frontend/vite.config.ts` (test.include)

**Interfaces:**
- Consumes: `messageRole`, `toolUIType`, `toolUIState`, `entryCreatedAt`, `turnSpans`, `TurnSpan` from `@/features/agent-chat/adapter`; `buildTimeline`, `collapseWorkLog`, `formatTurnStamp` from `@/features/agent-chat/timeline`; the vendored `Message`/`MessageContent`/`MessageResponse`, `Reasoning`/`ReasoningTrigger`/`ReasoningContent`, `Tool`/`ToolHeader`/`ToolContent`/`ToolInput`, `Task`/`TaskTrigger`/`TaskContent`.
- Produces: `MessagesTimeline({ view }: { view: AgentThreadView })` — unchanged prop signature, so `AgentChatPane` keeps calling it the same way.

`useTurnTimings` and its `Date.now()` ref-cache are **deleted**. Stamps now come from `entryCreatedAt`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/features/agent-chat/MessagesTimeline.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MessagesTimeline } from '@/features/agent-chat/MessagesTimeline'
import { emptyThreadView } from '@/features/agent-chat/eventReducer'
import type { AgentThreadView, ChatItem } from '@/features/agent-chat/types'

// Shiki compiles a real grammar and (depending on the engine) reaches for
// WASM, which is slow-to-impossible under jsdom. ToolInput renders a
// CodeBlock, so stub the vendored module: these tests are about which rows
// appear and what they say, not about highlighting.
vi.mock('@/components/ai-elements/code-block', () => ({
  CodeBlock: ({ code }: { code: string }) => <pre data-testid="code-block">{code}</pre>,
  CodeBlockCopyButton: () => null,
}))

afterEach(() => {
  cleanup()
})

function item(partial: Partial<ChatItem> & Pick<ChatItem, 'id' | 'kind'>): ChatItem {
  return { text: '', lastSequence: 0, ...partial }
}

function view(items: ChatItem[], overrides: Partial<AgentThreadView> = {}): AgentThreadView {
  return { ...emptyThreadView(), items, ...overrides }
}

describe('MessagesTimeline', () => {
  it('renders assistant markdown as markup, not as literal text', () => {
    render(<MessagesTimeline view={view([item({ id: 'a1', kind: 'assistant', text: '## Heading\n\nsome **bold** text' })])} />)

    expect(screen.getByRole('heading', { name: 'Heading' })).toBeInTheDocument()
    expect(screen.getByText('bold').tagName.toLowerCase()).toBe('strong')
  })

  it('marks a user turn as the user role', () => {
    const { container } = render(<MessagesTimeline view={view([item({ id: 'u1', kind: 'user', text: 'hello' })])} />)

    expect(screen.getByText('hello')).toBeInTheDocument()
    expect(container.querySelector('.is-user')).not.toBeNull()
  })

  it('renders an error item as an error, not as a message bubble', () => {
    render(<MessagesTimeline view={view([item({ id: 'e1', kind: 'error', text: 'claude exited 1' })])} />)

    expect(screen.getByRole('alert')).toHaveTextContent('claude exited 1')
  })

  it('keeps reasoning collapsed until it is opened', async () => {
    render(<MessagesTimeline view={view([item({ id: 'r1', kind: 'reasoning', text: 'thinking about the limiter' })])} />)

    expect(screen.queryByText(/thinking about the limiter/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /reasoning/i }))
    expect(screen.getByText(/thinking about the limiter/)).toBeInTheDocument()
  })

  it('shows a tool call with its name and its Running badge', () => {
    render(<MessagesTimeline view={view([item({ id: 't1', kind: 'tool', toolName: 'Edit', status: 'running' })])} />)

    expect(screen.getByText('Edit')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
  })

  it('reveals the tool arguments when the row is expanded', async () => {
    render(
      <MessagesTimeline
        view={view([item({ id: 't1', kind: 'tool', toolName: 'Edit', status: 'done', input: { file_path: '/a/b.go' } })])}
      />,
    )

    await userEvent.click(screen.getByText('Edit'))
    expect(screen.getByTestId('code-block')).toHaveTextContent('"file_path": "/a/b.go"')
  })

  it('folds all but the newest call of a run behind a disclosure', async () => {
    render(
      <MessagesTimeline
        view={view([
          item({ id: 't1', kind: 'tool', toolName: 'Read', status: 'done' }),
          item({ id: 't2', kind: 'tool', toolName: 'Grep', status: 'done' }),
          item({ id: 't3', kind: 'tool', toolName: 'Edit', status: 'done' }),
        ])}
      />,
    )

    // collapseWorkLog keeps the newest 1 visible; the other 2 fold.
    expect(screen.getByText('Edit')).toBeInTheDocument()
    expect(screen.queryByText('Read')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /2 earlier steps/i }))
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByText('Grep')).toBeInTheDocument()
  })

  it('stamps a completed turn from the event timestamps, not from a render-time clock', () => {
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'go', createdAt: 1_700_000_000_000 }),
            item({ id: 'a1', kind: 'assistant', text: 'done', createdAt: 1_700_000_010_000 }),
          ],
          { status: 'idle' },
        )}
      />,
    )

    expect(screen.getByText(/10s$/)).toBeInTheDocument()
  })

  it('does not stamp the trailing turn while it is still running', () => {
    render(
      <MessagesTimeline
        view={view(
          [
            item({ id: 'u1', kind: 'user', text: 'go', createdAt: 1_700_000_000_000 }),
            item({ id: 'a1', kind: 'assistant', text: 'partial', createdAt: 1_700_000_003_000 }),
          ],
          { status: 'running' },
        )}
      />,
    )

    expect(screen.queryByText(/\ds$/)).not.toBeInTheDocument()
  })

  it('warns when the stream had a sequence gap', () => {
    render(<MessagesTimeline view={view([item({ id: 'a1', kind: 'assistant', text: 'hi' })], { hasGap: true })} />)

    expect(screen.getByText(/updates may be missing/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Register the test file**

In `frontend/vite.config.ts`, in `test.include`, immediately after `'src/features/agent-chat/adapter.test.ts',` add:

```ts
      'src/features/agent-chat/MessagesTimeline.test.tsx',
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/agent-chat/MessagesTimeline.test.tsx`
Expected: FAIL — markdown renders as literal text, there is no `.is-user`, no `role="alert"`, no "Running" badge, and no stamp.

- [ ] **Step 4: Rewrite the component**

Replace the entire contents of `frontend/src/features/agent-chat/MessagesTimeline.tsx` with:

```tsx
/**
 * Renders `buildTimeline(view)` through the vendored AI Elements components.
 * Purely presentational: grouping lives in `timeline.ts` (pure, unit-tested),
 * the model-to-props mapping lives in `adapter.ts` (pure, unit-tested), and
 * this file only decides which component each `TimelineEntry` becomes.
 *
 * The one piece of state it owns is legitimately a UI concern: which
 * reasoning blocks and tool groups the user has expanded. `buildTimeline`
 * recomputes `collapsed: true` on every call, so it cannot hold that itself.
 *
 * Turn stamps come from `ChatItem.createdAt` (the orchestration event's own
 * timestamp). The previous implementation read `Date.now()` during render and
 * cached it in a ref, because `ChatItem` carried no timestamp; that hack and
 * its "approximate after a reconnect replays a whole thread" caveat are both
 * gone.
 */
import { Fragment, useState } from 'react'
import type { ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Task, TaskContent, TaskTrigger } from '@/components/ai-elements/task'
import { Tool, ToolContent, ToolHeader, ToolInput } from '@/components/ai-elements/tool'
import { entryCreatedAt, messageRole, toolUIState, toolUIType, turnSpans } from '@/features/agent-chat/adapter'
import { buildTimeline, collapseWorkLog, formatTurnStamp } from '@/features/agent-chat/timeline'
import type { ReasoningEntry, TimelineEntry, ToolGroupEntry } from '@/features/agent-chat/timeline'
import type { AgentThreadView, ChatItem } from '@/features/agent-chat/types'

export interface MessagesTimelineProps {
  view: AgentThreadView
}

function entryKey(entry: TimelineEntry, index: number): string {
  if (entry.kind === 'tool-group') return entry.items[0]?.id ?? `tool-group-${index}`
  return entry.item.id
}

/** An agent-reported failure. Deliberately not a `Message`: it is not part of
 *  the conversation, and it must reach a screen reader as an alert. */
function ErrorRow({ item }: { item: ChatItem }) {
  return (
    <div
      role="alert"
      className="self-stretch rounded-lg border border-devdeck-red-tint bg-devdeck-red-tint px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-devdeck-err"
    >
      {item.text}
    </div>
  )
}

/** A conversation turn. The user bubble keeps this app's accent tint rather
 *  than AI Elements' `bg-secondary` default — the tint is what the pane has
 *  always used, and a solid accent fill would break DESIGN.md's rule that the
 *  accent is never decorative. */
function MessageRow({ item }: { item: ChatItem }) {
  const isUser = item.kind === 'user'
  return (
    <Message from={messageRole(item.kind)} className="max-w-[86%]">
      <MessageContent
        className={cn(
          'font-mono text-[12.5px] leading-relaxed',
          isUser && 'group-[.is-user]:border group-[.is-user]:border-devdeck-border-accent group-[.is-user]:bg-devdeck-accent-tint',
        )}
      >
        <MessageResponse>{item.text || '…'}</MessageResponse>
      </MessageContent>
    </Message>
  )
}

function ReasoningRow({ entry, streaming }: { entry: ReasoningEntry; streaming: boolean }) {
  return (
    <Reasoning className="max-w-[86%] self-start" isStreaming={streaming} defaultOpen={false}>
      <ReasoningTrigger />
      <ReasoningContent>{entry.item.text}</ReasoningContent>
    </Reasoning>
  )
}

/** One tool call. `ToolInput` is rendered only when arguments actually
 *  arrived; `ToolOutput` never is — the Claude provider does not parse
 *  `tool_result`, so this app has no tool output to show. */
function ToolRow({ item }: { item: ChatItem }) {
  return (
    <Tool>
      <ToolHeader type={toolUIType(item.toolName)} state={toolUIState(item.status)} />
      {item.input === undefined ? null : (
        <ToolContent>
          <ToolInput input={item.input} />
        </ToolContent>
      )}
    </Tool>
  )
}

/** A run of consecutive calls. Everything but the newest folds behind a
 *  disclosure — a turn that reads twenty files must not push the prose off
 *  screen. */
function ToolGroupRow({ entry, expanded, onToggle }: { entry: ToolGroupEntry; expanded: boolean; onToggle: () => void }) {
  const { visible, hidden } = collapseWorkLog(entry.items)
  return (
    <div className="flex w-full flex-col">
      {hidden.length > 0 ? (
        <Task open={expanded} onOpenChange={onToggle}>
          <TaskTrigger title={`${hidden.length} earlier ${hidden.length === 1 ? 'step' : 'steps'}`} />
          <TaskContent>
            {hidden.map((item) => (
              <ToolRow key={item.id} item={item} />
            ))}
          </TaskContent>
        </Task>
      ) : null}
      {visible.map((item) => (
        <ToolRow key={item.id} item={item} />
      ))}
    </div>
  )
}

function TurnStamp({ startedAt, completedAt }: { startedAt: number; completedAt: number }) {
  return <div className="self-start px-1 font-mono text-[10px] text-devdeck-dim-pane">{formatTurnStamp(startedAt, completedAt)}</div>
}

export function MessagesTimeline({ view }: MessagesTimelineProps) {
  const entries = buildTimeline(view)
  const spans = turnSpans(entries)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const lastIndex = entries.length - 1

  return (
    <div className="flex flex-col gap-2.5 px-4 py-4">
      {entries.map((entry, index) => {
        const key = entryKey(entry, index)

        // A turn stamp renders on the turn's last entry, but only once that
        // turn is settled. The trailing turn is settled when the thread
        // itself stops running; an earlier turn always is, because the next
        // turn's user message already arrived after it.
        const span = spans.find((s) => s.lastEntryIndex === index)
        const isTrailingTurn = span?.lastEntryIndex === lastIndex
        const settled = span !== undefined && (!isTrailingTurn || view.status !== 'running')
        const startedAt = span ? entryCreatedAt(entries[span.firstEntryIndex]) : undefined
        const completedAt = span ? entryCreatedAt(entries[span.lastEntryIndex]) : undefined

        let node: ReactNode
        if (entry.kind === 'message') {
          node = entry.item.kind === 'error' ? <ErrorRow item={entry.item} /> : <MessageRow item={entry.item} />
        } else if (entry.kind === 'reasoning') {
          node = <ReasoningRow entry={entry} streaming={view.status === 'running' && index === lastIndex} />
        } else {
          const groupKey = `tool-group:${key}`
          node = <ToolGroupRow entry={entry} expanded={expanded.has(groupKey)} onToggle={() => toggle(groupKey)} />
        }

        return (
          <Fragment key={key}>
            {node}
            {settled && startedAt !== undefined && completedAt !== undefined ? (
              <TurnStamp startedAt={startedAt} completedAt={completedAt} />
            ) : null}
          </Fragment>
        )
      })}
      {view.hasGap ? (
        <div className="flex items-center gap-1.5 self-center rounded-full border border-devdeck-hairline bg-devdeck-raised px-2.5 py-1 font-mono text-[10.5px] text-devdeck-fg-2">
          <AlertTriangle size={11} className="text-devdeck-wait" />
          Some updates may be missing from this thread
        </div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/agent-chat/MessagesTimeline.test.tsx`
Expected: PASS, 10 tests.

If `Reasoning`'s trigger has no accessible name matching `/reasoning/i`, read `src/components/ai-elements/reasoning.tsx` and update the test's selector to the label the vendored `ReasoningTrigger` actually renders. Adjust the test, not the vendored file.

- [ ] **Step 6: Run the whole agent-chat suite and typecheck**

Run: `cd frontend && npx vitest run src/features/agent-chat && npm run typecheck`
Expected: `MessagesTimeline`, `adapter`, `eventReducer`, `timeline` pass. `AgentChatPane.test.tsx` may now fail — Task 6 owns it. Note which of its assertions broke and move on.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/agent-chat/MessagesTimeline.tsx frontend/src/features/agent-chat/MessagesTimeline.test.tsx frontend/vite.config.ts
git commit --no-verify -m "feat(agent-chat): render the timeline through AI Elements

Markdown, syntax-highlighted tool arguments, and collapsible reasoning
replace whitespace-pre-wrap. Turn stamps now come from ChatItem.createdAt,
retiring the Date.now()-during-render ref cache."
```

---

### Task 6: Rewrite `AgentChatPane` on `Conversation` and delete `scrollAnchoring`

**Files:**
- Modify: `frontend/src/features/agent-chat/AgentChatPane.tsx`
- Modify: `frontend/src/features/agent-chat/AgentChatPane.test.tsx`
- Delete: `frontend/src/features/agent-chat/scrollAnchoring.ts`
- Delete: `frontend/src/features/agent-chat/scrollAnchoring.test.ts`
- Modify: `frontend/vite.config.ts` (remove the `scrollAnchoring.test.ts` entry)

**Interfaces:**
- Consumes: `Conversation`, `ConversationContent`, `ConversationEmptyState`, `ConversationScrollButton` from `@/components/ai-elements/conversation`; `MessagesTimeline` from Task 5.
- Produces: `AgentChatPane` with its `AgentChatPaneProps` unchanged (`worktreeId`, `threadKey`, `machine`, `worktreeLabel`, `branch`).

- [ ] **Step 1: Extend the existing test file**

`frontend/src/features/agent-chat/AgentChatPane.test.tsx` already covers the connecting, empty, and error states and must keep doing so. Add to its existing `describe('AgentChatPane', …)` block:

```tsx
  it('renders the timeline once messages exist', () => {
    mockSocket.mockReturnValue({
      view: {
        ...emptyThreadView(),
        items: [{ id: 'a1', kind: 'assistant', text: 'the limiter is in place', lastSequence: 0, createdAt: 1_700_000_000_000 }],
      },
      status: 'open',
      sendTurn: vi.fn(),
      abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(),
      setInteractionMode: vi.fn(),
    })
    render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    expect(screen.getByText(/the limiter is in place/)).toBeInTheDocument()
    expect(screen.queryByText(/no messages yet/i)).not.toBeInTheDocument()
  })

  it('keeps the existing timeline on screen while reconnecting mid-thread', () => {
    mockSocket.mockReturnValue({
      view: {
        ...emptyThreadView(),
        items: [{ id: 'a1', kind: 'assistant', text: 'earlier reply', lastSequence: 0, createdAt: 1_700_000_000_000 }],
      },
      status: 'connecting',
      sendTurn: vi.fn(),
      abortTurn: vi.fn(),
      setRuntimeMode: vi.fn(),
      setInteractionMode: vi.fn(),
    })
    render(<AgentChatPane worktreeId="w-abc" threadKey="w-abc" machine={machine} />)

    expect(screen.getByText(/earlier reply/)).toBeInTheDocument()
    expect(screen.queryByText(/connecting/i)).not.toBeInTheDocument()
  })
```

Add the same `vi.mock('@/components/ai-elements/code-block', …)` stub used in Task 5's test file, and add an `afterEach(cleanup)` if the file does not already have one (importing `cleanup` and `afterEach` as needed).

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd frontend && npx vitest run src/features/agent-chat/AgentChatPane.test.tsx`
Expected: the two new tests FAIL (or the file fails to render) until Step 4 lands.

- [ ] **Step 3: Delete the superseded scroll module**

```bash
cd /Users/kiyora/Documents/explorer/agent/enginer.kiyora.dev
git rm frontend/src/features/agent-chat/scrollAnchoring.ts frontend/src/features/agent-chat/scrollAnchoring.test.ts
```

Then remove this line from `frontend/vite.config.ts`'s `test.include`:

```ts
      'src/features/agent-chat/scrollAnchoring.test.ts',
```

- [ ] **Step 4: Rewrite the pane's scroll container**

In `frontend/src/features/agent-chat/AgentChatPane.tsx`:

**4a.** Replace the import block's `useCallback, useEffect, useMemo, useRef, useState` with `useMemo, useState`, drop the `shouldFollow` import, and add:

```tsx
import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from '@/components/ai-elements/conversation'
import { MessageSquare } from 'lucide-react'
```

**4b.** Delete `scrollRef`, `followRef`, `handleScroll`, and the `useEffect` that assigns `el.scrollTop` (currently lines 86-102). `Conversation` wraps `use-stick-to-bottom`, which owns follow-mode including the re-arm-on-scroll-up behaviour `shouldFollow` implemented by hand.

**4c.** Replace the scroll `<div>` and its children (currently lines 120-130) with:

```tsx
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="p-0">
          {showConnecting ? (
            <PaneMessage>Connecting to the agent…</PaneMessage>
          ) : view.error ? (
            <PaneMessage tone="error">{view.error}</PaneMessage>
          ) : view.items.length === 0 ? (
            <ConversationEmptyState
              className="min-h-[220px]"
              icon={<MessageSquare className="size-5 text-devdeck-fg-2" aria-hidden="true" />}
              title="No messages yet"
              description="Say hello below to start the thread."
            />
          ) : (
            <MessagesTimeline view={view} />
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
```

Keep `PaneMessage` and the `showConnecting` derivation exactly as they are — a reconnect mid-thread must not blank the transcript.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/agent-chat/AgentChatPane.test.tsx`
Expected: PASS, 5 tests. `use-stick-to-bottom` needs `ResizeObserver`, which `vitest.setup.ts` already stubs.

- [ ] **Step 6: Confirm nothing still imports the deleted module**

Run: `cd frontend && grep -rn "scrollAnchoring" src/ vite.config.ts`
Expected: no output.

- [ ] **Step 7: Typecheck**

Run: `cd frontend && npm run typecheck`
Expected: only the four pre-existing errors.

- [ ] **Step 8: Commit**

```bash
git add -A frontend/src/features/agent-chat frontend/vite.config.ts
git commit --no-verify -m "feat(agent-chat): Conversation owns follow-mode; drop scrollAnchoring

use-stick-to-bottom subsumes shouldFollow's re-arm band, so the hand-rolled
module and its follow-mode refs are deleted. Reconnect still keeps the
existing transcript on screen."
```

---

### Task 7: Rewrite `ChatComposer` on `PromptInput`

**Files:**
- Modify: `frontend/src/features/agent-chat/ChatComposer.tsx`
- Modify: `frontend/src/features/agent-chat/ChatComposer.test.tsx`

**Interfaces:**
- Consumes: `PromptInput`, `PromptInputBody`, `PromptInputTextarea`, `PromptInputFooter`, `PromptInputTools`, `PromptInputSubmit`, and the `PromptInputMessage` interface from `@/components/ai-elements/prompt-input`; `promptChatStatus` from `@/features/agent-chat/adapter`.
- Produces: `ChatComposer` with `ChatComposerProps` unchanged (`status`, `onSend`, `onAbort`, `worktree`, `branch`, `controls`).

**Keep, do not remove:** the `@container/composer` dual render of `ComposerControls` (inline row + `TabStripPopoverMenu` overflow copy) and `ChatStatusStrip`. `PromptInputTools` is a plain flex row and does no overflow collapsing — dropping the dual render would reintroduce the four-rows-of-wrapped-pills bug the t3code-parity spec fixed. The pills stay on `@base-ui/react` because they carry `useNativeOverlayBlocker`, which the Tauri webview needs and the Radix `Select` does not have.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/features/agent-chat/ChatComposer.test.tsx`, inside its existing `describe` block:

```tsx
  it('sends on Enter and inserts a newline on Shift+Enter', async () => {
    const onSend = vi.fn()
    render(<ChatComposer status="idle" onSend={onSend} onAbort={vi.fn()} controls={controls} />)

    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'add rate limiting{Shift>}{Enter}{/Shift}second line')
    expect(onSend).not.toHaveBeenCalled()

    await userEvent.type(box, '{Enter}')
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(onSend.mock.calls[0][0]).toContain('add rate limiting')
    expect(onSend.mock.calls[0][0]).toContain('second line')
  })

  it('clears the box after a send', async () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} />)

    const box = screen.getByRole('textbox')
    await userEvent.type(box, 'hello{Enter}')
    expect(box).toHaveValue('')
  })

  it('does not send an empty or whitespace-only message', async () => {
    const onSend = vi.fn()
    render(<ChatComposer status="idle" onSend={onSend} onAbort={vi.fn()} controls={controls} />)

    await userEvent.type(screen.getByRole('textbox'), '   {Enter}')
    expect(onSend).not.toHaveBeenCalled()
  })

  // The backend decider explicitly allows a follow-up message to steer an
  // in-flight turn, so Enter must keep working while running. Only the BUTTON
  // becomes an interrupt.
  it('still steers an in-flight turn from the keyboard', async () => {
    const onSend = vi.fn()
    const onAbort = vi.fn()
    render(<ChatComposer status="running" onSend={onSend} onAbort={onAbort} controls={controls} />)

    await userEvent.type(screen.getByRole('textbox'), 'also add tests{Enter}')
    expect(onSend).toHaveBeenCalledWith('also add tests')
    expect(onAbort).not.toHaveBeenCalled()
  })

  it('turns the action button into an interrupt while running', async () => {
    const onSend = vi.fn()
    const onAbort = vi.fn()
    render(<ChatComposer status="running" onSend={onSend} onAbort={onAbort} controls={controls} />)

    await userEvent.click(screen.getByRole('button', { name: /stop/i }))
    expect(onAbort).toHaveBeenCalledTimes(1)
    expect(onSend).not.toHaveBeenCalled()
  })

  it('keeps the status strip below the input', () => {
    render(<ChatComposer status="idle" onSend={vi.fn()} onAbort={vi.fn()} controls={controls} worktree="auth" branch="feat/auth" />)

    expect(screen.getByText('auth')).toBeInTheDocument()
    expect(screen.getByText('feat/auth')).toBeInTheDocument()
  })
```

Delete the existing `it('renders a circular icon send button, not a labelled one', …)` test — `PromptInputSubmit` renders its own button and asserting on `rounded-full` in its className pins vendored styling this plan does not own. The interrupt-vs-send behaviour is covered by the two tests above.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend && npx vitest run src/features/agent-chat/ChatComposer.test.tsx`
Expected: the `/stop/i` button lookup fails (the current button is labelled `Interrupt`), and the steer-while-running test fails.

- [ ] **Step 3: Rewrite the composer**

Replace the body of `frontend/src/features/agent-chat/ChatComposer.tsx` — keeping its existing doc comment, extended with the two notes below — with:

```tsx
import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from '@/components/ai-elements/prompt-input'
import type { PromptInputMessage } from '@/components/ai-elements/prompt-input'
import { TabStripPopoverMenu } from '@/components/ui/tab-strip-popover-menu'
import { promptChatStatus } from '@/features/agent-chat/adapter'
import { ChatStatusStrip } from '@/features/agent-chat/ChatStatusStrip'
import { composerControlClassName } from '@/features/agent-chat/ComposerControl'
import { ComposerControls } from '@/features/agent-chat/ComposerControls'
import type { ComposerControlsProps } from '@/features/agent-chat/ComposerControls'
import { emptyThreadView } from '@/features/agent-chat/eventReducer'
import type { AgentThreadView } from '@/features/agent-chat/types'

export interface ChatComposerProps {
  status: AgentThreadView['status']
  onSend: (text: string) => void
  onAbort: () => void
  worktree?: string
  branch?: string | null
  controls: Omit<ComposerControlsProps, 'variant'>
}

export function ChatComposer({ status, onSend, onAbort, worktree, branch, controls }: ChatComposerProps) {
  const [text, setText] = useState('')

  // PromptInputSubmit reads a ChatStatus, not this app's thread status. Route
  // it through the same mapping the adapter unit-tests, so "which button does
  // the user see" has one definition.
  const chatStatus = promptChatStatus({ ...emptyThreadView(), status })

  function handleSubmit(message: PromptInputMessage) {
    const trimmed = (message.text ?? '').trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
  }

  return (
    <div className="flex flex-none flex-col border-t border-devdeck-line bg-devdeck-pane">
      <PromptInput
        onSubmit={handleSubmit}
        className="@container/composer mx-3 mt-2.5 mb-2 rounded-lg border border-devdeck-hairline bg-devdeck-raised"
      >
        <PromptInputBody>
          <PromptInputTextarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Ask for follow-up changes… (Enter to send, Shift+Enter for a new line)"
            className="font-mono text-[12.5px]"
          />
        </PromptInputBody>

        <PromptInputFooter>
          <PromptInputTools className="min-w-0 flex-1 overflow-hidden">
            <div
              data-testid="composer-controls-inline"
              className="hidden min-w-0 flex-nowrap items-center gap-0.5 overflow-hidden @sm/composer:flex"
            >
              <ComposerControls {...controls} variant="inline" />
            </div>
            <div className="@sm/composer:hidden">
              <TabStripPopoverMenu
                trigger={<MoreHorizontal size={14} aria-hidden="true" />}
                triggerClassName={cn(composerControlClassName, 'flex w-7 items-center justify-center px-0')}
                triggerTitle="More controls"
                triggerAriaLabel="More controls"
                align="start"
              >
                <div data-testid="composer-controls-menu" className="flex flex-col gap-1">
                  <ComposerControls {...controls} variant="menu" />
                </div>
              </TabStripPopoverMenu>
            </div>
          </PromptInputTools>

          <PromptInputSubmit status={chatStatus} onStop={onAbort} disabled={chatStatus === 'ready' && text.trim().length === 0} />
        </PromptInputFooter>
      </PromptInput>

      <ChatStatusStrip worktree={worktree ?? '—'} branch={branch} />
    </div>
  )
}
```

Add these two paragraphs to the file's existing doc comment:

```
 * Built on the vendored `PromptInput`. `PromptInputTextarea` owns the
 * Enter/Shift+Enter contract (it calls `form.requestSubmit()` directly), and
 * `PromptInputSubmit` swaps itself to a `type="button"` stop control while the
 * status is `streaming`. That combination is what keeps "steer an in-flight
 * turn with Enter" working while the button reads as an interrupt.
 *
 * The `@container/composer` dual render of `ComposerControls` stays.
 * `PromptInputTools` is a flex row with no overflow collapsing of its own, so
 * removing the second copy would bring back the four-wrapped-rows bug. The
 * pills also stay on `@base-ui/react`, because they carry
 * `useNativeOverlayBlocker` for the Tauri webview.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd frontend && npx vitest run src/features/agent-chat/ChatComposer.test.tsx`
Expected: PASS.

If the stop button's accessible name is not matched by `/stop/i`, read the vendored `PromptInputSubmit` (it sets `aria-label={isGenerating ? 'Stop' : 'Submit'}`) and align the selector. Adjust the test, not the vendored file.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `cd frontend && npx vitest run && npm run typecheck`
Expected: the whole allowlisted suite passes. Only the four pre-existing `Header.tsx` / `w.$wsId.tsx` errors remain.

- [ ] **Step 6: Build and record the bundle delta**

Run: `cd frontend && npm run build`
Expected: build succeeds. Note the largest emitted chunk in the commit message. `shiki` plus `streamdown` is the biggest dependency addition this app has taken; if the chat chunk dominates the output, say so — the follow-up is a `React.lazy` boundary around `code-block`, which is deliberately out of scope here.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/features/agent-chat/ChatComposer.tsx frontend/src/features/agent-chat/ChatComposer.test.tsx
git commit --no-verify -m "feat(agent-chat): composer on PromptInput

Enter still steers an in-flight turn; the button becomes a stop control while
streaming. Keeps the container-query dual render of the pills (PromptInputTools
does no overflow collapsing) and the base-ui pills for useNativeOverlayBlocker."
```

---

## Non-goals

Carried from the spec, plus one correction found while writing this plan.

- **`ToolOutput` renders nothing.** `grep -r "tool_result" backend/internal/` returns no hits — the Claude provider parses `tool_use` blocks but never the `tool_result` blocks that carry results. Tool cards show name, arguments, and status.
- **`Confirmation` (Allow / Deny) is not installed.** `ReqCommandExecApproval` and friends exist in the event taxonomy (`event/event.go:102-107`) but `useAgentChatSocket` handles no `request.opened` frame.
- **`Context` (the token meter) is dropped from this plan.** The spec listed it, and it cannot work: the Claude parser does populate `event.Usage` (`provider/claude/parse.go:231-234`), but Ingestion's `TurnCompleted` branch (`orchestration/workers.go:140-146`) dispatches only `{status: idle}` and discards the payload. Usage never reaches the client. `AgentThreadView.usage` is therefore also not added — a field nothing can populate is worse than no field. Wiring it is a backend change.
- **Transport is unchanged.** The WebSocket, `sinceSeq` replay, and the offline command outbox stay exactly as they are. AI Elements needs no `useChat` and no SSE.
- **No light theme, no app-wide restyle.** Only the chat pane consumes the new surface tokens.

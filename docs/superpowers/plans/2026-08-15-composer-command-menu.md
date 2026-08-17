# Plan — Composer Command Menu (Subsystem D)

Spec: `docs/superpowers/specs/2026-08-15-composer-command-menu-design.md`

Builds on: `docs/superpowers/plans/2026-08-14-composer-shell-tiptap-editor.md`
(T1–T6, already merged — this plan reads their output, never re-does it:
`composerSerialize.ts`, `ComposerChip.tsx`, `composerNodes.ts`,
`composerMention.ts`, `ComposerPromptEditor.tsx`, `ChatComposer.tsx` all
already exist).

Execution: TDD throughout. Tests are written before the implementation they
cover, and every task ends with its own tests green.

Frontend only. **No Go file is touched by any task in this plan** — the spec's
own "Where this sits" table confirms the skill catalog (`detect/skills.go:37-82`
→ `handler/agent.go:54-61` → route `cmd/server/main.go:643` →
`machineApi.ts:506-508` → `queries.ts:1425-1432`) and the interaction-mode sink
(`useAgentChatSocket.ts:325`) are already routed and reachable; D only adds
consumers.

## Dependency shape

```
D1 serialize ──────────────────────────────┐
                                             ├─▶ D5 editor wiring ─▶ D6 shell wiring
D2 popup + @ fix ─┬─▶ D3 $ skill trigger ───┤
                  └─▶ D4 / slash trigger ───┘
```

- **D1** and **D2** are independent of each other and of everything else —
  run in parallel first.
- **D3** and **D4** each depend only on D2 (the shared popup); neither touches
  the other's files or reads the other's output — run in parallel once D2
  lands.
- **D5** needs D1, D2, D3 and D4 all merged — it is the convergence point that
  assembles all four into the real editor.
- **D6** needs D5.

## File ownership

No file is written by two tasks.

| Task | Writes |
|---|---|
| D1 | `composerSerialize.ts`, `composerSerialize.test.ts` |
| D2 | `ComposerSuggestionMenu.tsx`, `ComposerSuggestionMenu.test.tsx`, `composerMention.ts` |
| D3 | `composerSkillTrigger.ts`, `composerSkillTrigger.test.ts` |
| D4 | `composerSlashTrigger.ts`, `composerSlashTrigger.test.ts` |
| D5 | `ComposerPromptEditor.tsx`, `ComposerPromptEditor.test.tsx` |
| D6 | `ChatComposer.tsx`, `ChatComposer.test.tsx`, `AgentChatPane.test.tsx` |

All under `frontend/src/features/agent-chat/`.

**`ComposerSuggestionMenu.tsx`/`.test.tsx` is a stated addition beyond the
spec's literal "New" file list** (which names only the popup file, not a test
for it — see spec's "Files" section). TDD requires a test for new behavior;
since the popup's three-state rendering and keyboard nav are real logic, not
pass-through, this plan gives it its own component test rather than relying
only on indirect coverage through D3/D4's consumers.

**Read but never written by any task:** `composerMention.test.ts`. The spec's
own gate for D2 is that this file stays green **unmodified** — it is the proof
the popup extraction changed no behavior (spec: "the proof that this is an
extraction and not a redesign is that `composerMention.test.ts` stays green
unmodified"). If satisfying it ever requires editing that file, the extraction
changed behavior and must be reconsidered, not accommodated.

**Convergence files (CLAUDE.md):** none of `routeTree.gen.ts`,
`useDevDeckStore.ts`, `store/types.ts`, `domain/models.go`, `cmd/server/main.go`,
`port/store.go` are touched by any task in this plan. D reads `AgentSkill`
(`store/types.ts:381-386`), `InteractionMode` (`useAgentChatSocket.ts:47`) and
`Machine` from their existing locations but adds nothing to them and needs no
serialization against any other parallel workstream on that account.

**Commit granularity.** The spec is explicit (its own "Risks" section): the
pre-commit hook typechecks the whole project, so this cannot land file-by-file.
Tasks below are scoped for review and (where marked) parallel dispatch, but the
actual `git commit` happens once, after Review/Fix/Finalize, over the whole
change — no task ends with its own commit step.

## Known-good baseline

`npm test` (from `frontend/`) has **one pre-existing failure**, in the monaco
guard test. It is not caused by this work and must not be "fixed" here. **Any
second failure is a real regression** and blocks the task that introduced it.

---

## D1 — Skill chip serialization fix (independent, parallel with D2)

The defect this whole spec exists to close: `composerSerialize.ts:54-57`/`:112`
still emit a bare `$name` for a skill chip, which a following character or
chip swallows unrecoverably (spec Problem §1). No skill chip has ever been
inserted yet (D3 is the first producer), so this is the one moment to change
the wire form without migrating anything already sent.

**Files:**
- Modify: `composerSerialize.ts`
- Modify: `composerSerialize.test.ts`

**Interfaces:**
- Consumes: nothing new — pure functions over the existing `ComposerDoc`/
  `ComposerChipNode` shapes.
- Produces: `serializeComposerDoc` now emits `[$name](skill:name)` for a
  `skill` chip. `composerSkillChip`, `composerChipNodeToChip`, `ComposerDoc`
  and every other export's name/signature is unchanged — D3/D5 depend on that
  stability, not on this task directly.

### Step 1: Write the failing tests

Rewrite the one assertion that encodes the defect (`composerSerialize.test.ts:80-82`,
currently `expect(...).toBe('$review')`) and add the new cases the spec's
Testing section calls for:

```ts
it('serializes a skill chip to a bracketed, scheme-qualified link', () => {
  expect(serializeComposerDoc(doc(composerSkillChip('review')))).toBe('[$review](skill:review)')
})

it('does not let a skill chip swallow the word that follows it', () => {
  const result = serializeComposerDoc(doc(composerSkillChip('review'), composerText('please')))
  expect(result).toBe('[$review](skill:review)please')
})

it('keeps two adjacent skill chips separately readable', () => {
  const result = serializeComposerDoc(doc(composerSkillChip('review'), composerSkillChip('refactor')))
  expect(result).toBe('[$review](skill:review)[$refactor](skill:refactor)')
})

it('keeps a skill chip and a file chip separately readable, adjacent', () => {
  const result = serializeComposerDoc(doc(composerSkillChip('review'), composerFileChip('src/app.tsx')))
  expect(result).toBe('[$review](skill:review)[app.tsx](src/app.tsx)')
})

it('encodes a skill name containing spaces', () => {
  expect(serializeComposerDoc(doc(composerSkillChip('Data Report')))).toBe('[$Data Report](skill:Data%20Report)')
})

it('escapes brackets in the skill label', () => {
  // escapeMarkdownLinkLabel only escapes \, [, ] — the label never needs
  // paren-escaping (that's only special inside the destination).
  expect(serializeComposerDoc(doc(composerSkillChip('foo[bar]')))).toBe('[$foo\\[bar\\]](skill:foo%5Bbar%5D)')
})

it('escapes parentheses and percent in the skill destination', () => {
  expect(serializeComposerDoc(doc(composerSkillChip('foo(bar)%baz')))).toBe(
    '[$foo(bar)%baz](skill:foo%28bar%29%25baz)',
  )
})
```

Both expected strings above were computed by running
`escapeMarkdownLinkLabel`/`encodeMarkdownLinkDestination` directly (`node -e`),
not guessed — `encodeURI` leaves `(`/`)`/`%` alone by default, which is why
`encodeMarkdownLinkDestination`'s explicit `.replaceAll('(', '%28')` etc.
exist at all (`composerSerialize.ts:41-48`); get this wrong and the test
would silently assert the pre-fix behavior.

Add the discrimination-invariant test (spec §1, "the property any future
parser needs"):

```ts
it('discriminates file and skill chips by scheme — file never carries one, skill always does', () => {
  const fileResult = serializeComposerDoc(doc(composerFileChip('src/app.tsx')))
  const skillResult = serializeComposerDoc(doc(composerSkillChip('code-review')))
  expect(fileResult).not.toMatch(/\]\(skill:/)
  expect(skillResult).toMatch(/\]\(skill:/)
})
```

And confirm `label` is still ignored for skill chips too (mirrors the existing
file-chip case at `:88-91`):

```ts
it('ignores label and only serializes value for a skill chip', () => {
  const result = serializeComposerDoc(doc(composerSkillChip('review', 'a totally different label')))
  expect(result).toBe('[$review](skill:review)')
})
```

Leave the terminal-context test (`:84-86`, `'@terminal-1:12-13'`) untouched —
`CHIP_PREFIX` still covers that kind; only `skill` moves off it.

### Step 2: Run the tests, confirm they fail

```
npx vitest run src/features/agent-chat/composerSerialize.test.ts
```

Expected: the rewritten `'$review'` assertion fails (still produces the old
bare form), and every new test referencing the bracketed skill form fails
with the old output.

### Step 3: Implement

```ts
// CHIP_PREFIX narrows to the one kind that keeps its bare prefix — 'file'
// left the record two specs ago, 'skill' leaves it here.
const CHIP_PREFIX: Record<Exclude<ComposerChipKind, 'file' | 'skill'>, string> = {
  terminalContext: '@',
}

function serializeInlineNode(node: ComposerInlineNode): string {
  if (node.type === 'text') return node.text
  if (node.kind === 'file') {
    const label = escapeMarkdownLinkLabel(composerFileLinkBasename(node.value))
    return `[${label}](${encodeMarkdownLinkDestination(node.value)})`
  }
  if (node.kind === 'skill') {
    // Brackets delimit the label; ':skill' as a literal destination scheme
    // (never run through the encoder, so it can't be swallowed) is what makes
    // this mutually exclusive with a file chip's destination — see the
    // discrimination-invariant test above.
    const label = escapeMarkdownLinkLabel(`$${node.value}`)
    return `[${label}](skill:${encodeMarkdownLinkDestination(node.value)})`
  }
  return `${CHIP_PREFIX[node.kind]}${node.value}`
}
```

No other export changes. `composerSkillChip`, `parseComposerText`,
`ComposerChipNode`, etc. are untouched.

### Step 4: Run the tests, confirm they pass

```
npx vitest run src/features/agent-chat/composerSerialize.test.ts
```

Expected: all pass, including the untouched terminal-context and file-chip
cases (regression check within the same file).

**Done when:** `composerSerialize.test.ts` is fully green and contains no
reference to the old `'$review'` form.

---

## D2 — Shared suggestion popup, extracted, plus the `\n`-prefix fix on `@` (independent, parallel with D1)

Two things bundled because they touch the same file for the same reason: `$`
and `/` (D3/D4) each need a popup, and writing it a third time is what the
spec explicitly rejects ("D would otherwise write it twice more"). Extracting
it means opening `composerMention.ts`, and the file being open is also where
the `allowedPrefixes` fix belongs — see spec Problem §3: `@tiptap/suggestion`'s
`allowedPrefixes` defaults to `[' ']` and rejects `'\n'`
(`node_modules/@tiptap/suggestion/dist/index.js:646`, verified by reading the
installed package — `mentionAllow`'s own `/\s/` rule never gets a chance to
run because the match is discarded first).

**Files:**
- Create: `ComposerSuggestionMenu.tsx`
- Create: `ComposerSuggestionMenu.test.tsx`
- Modify: `composerMention.ts`

**Interfaces:**
- Consumes: nothing new from other D tasks.
- Produces (for D3/D4 to consume):
  ```ts
  export interface ComposerSuggestionMenuItem {
    id: string
    label: string
    description?: string
    icon: LucideIcon
  }

  export interface ComposerSuggestionMenuProps<Item extends ComposerSuggestionMenuItem>
    extends SuggestionProps<Item, Item> {
    /** Stamped as `data-${itemTestAttr}` on each item button — e.g.
     *  'mention-item' -> `data-mention-item`, so each trigger keeps its own
     *  existing DOM-query contract after the extraction. */
    itemTestAttr: string
    /** A fetch failure, not "no results for this query" — overrides
     *  loading/empty entirely when non-null. */
    errorMessage?: string | null
    /** Shown when the (non-error) result set is empty and loading has
     *  finished. Omitted (undefined/null) reproduces the file mention's
     *  original behavior: render nothing. */
    emptyMessage?: string | null
  }

  export interface ComposerSuggestionMenuHandle {
    onKeyDown: (props: SuggestionKeyDownProps) => boolean
  }

  export const ComposerSuggestionMenu: <Item extends ComposerSuggestionMenuItem>(
    props: ComposerSuggestionMenuProps<Item> & RefAttributes<ComposerSuggestionMenuHandle>,
  ) => ReactNode // forwardRef, generic — see Step 3's note on the cast this needs
  ```
- `composerMention.ts` keeps its existing exports (`isMentionWordStart`,
  `mentionAllow`, `createComposerMention`) unchanged in name and signature —
  D3 imports `mentionAllow` directly, D5 imports `createComposerMention`
  unchanged.

### Step 1: Write the failing tests (`ComposerSuggestionMenu.test.tsx`)

Plain component tests — no ProseMirror/editor needed, `items`/`command`/
`loading` are mock props:

```tsx
import { createElement, createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { File } from 'lucide-react'
import { afterEach } from 'vitest'
import { ComposerSuggestionMenu } from '@/features/agent-chat/ComposerSuggestionMenu'
import type { ComposerSuggestionMenuHandle, ComposerSuggestionMenuItem } from '@/features/agent-chat/ComposerSuggestionMenu'

afterEach(cleanup)

const ITEMS: ComposerSuggestionMenuItem[] = [
  { id: 'a', label: 'Alpha', icon: File },
  { id: 'b', label: 'Beta', description: 'the second one', icon: File },
]

function renderMenu(overrides: Partial<React.ComponentProps<typeof ComposerSuggestionMenu>> = {}) {
  const command = vi.fn()
  const ref = createRef<ComposerSuggestionMenuHandle>()
  const utils = render(
    createElement(ComposerSuggestionMenu, {
      items: ITEMS,
      command,
      loading: false,
      itemTestAttr: 'test-item',
      ref,
      ...overrides,
    }),
  )
  return { ...utils, command, ref }
}

describe('ComposerSuggestionMenu — states', () => {
  it('renders nothing for an empty, non-loading result with no emptyMessage', () => {
    const { container } = renderMenu({ items: [] })
    expect(container.firstChild).toBeNull()
  })

  it('renders a loading indicator for an empty, loading result', () => {
    const { getByText } = renderMenu({ items: [], loading: true })
    expect(getByText('Searching…')).toBeTruthy()
  })

  it('renders emptyMessage for an empty, non-loading result when provided', () => {
    const { getByText } = renderMenu({ items: [], emptyMessage: 'No skills found' })
    expect(getByText('No skills found')).toBeTruthy()
  })

  it('renders errorMessage instead of anything else, even mid-loading with items present', () => {
    const { getByText, queryByText } = renderMenu({ loading: true, errorMessage: "Couldn't load skills for claude" })
    expect(getByText("Couldn't load skills for claude")).toBeTruthy()
    expect(queryByText('Alpha')).toBeNull()
  })
})

describe('ComposerSuggestionMenu — list', () => {
  it('stamps each item with the given test attribute and shows label/description', () => {
    const { container, getByText } = renderMenu()
    expect(container.querySelector('[data-test-item="a"]')).not.toBeNull()
    expect(container.querySelector('[data-test-item="b"]')).not.toBeNull()
    expect(getByText('the second one')).toBeTruthy()
  })

  it('clicking an item calls command with that item', () => {
    const { container, command } = renderMenu()
    fireEvent.click(container.querySelector('[data-test-item="b"]') as HTMLButtonElement)
    expect(command).toHaveBeenCalledWith(ITEMS[1])
  })

  it('ArrowDown/ArrowUp cycle the highlight, Enter selects the highlighted item', () => {
    const { ref, command } = renderMenu()
    // The imperative handle is called directly here (this component's own
    // contract — tiptap's render().onKeyDown calls it the same way), not
    // through fireEvent, so each call needs its own act() to flush the
    // setHighlighted update before the next call reads it.
    let handled = false
    act(() => {
      handled = ref.current!.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'ArrowDown' }) } as never)
    })
    expect(handled).toBe(true)
    act(() => {
      ref.current!.onKeyDown({ event: new KeyboardEvent('keydown', { key: 'Enter' }) } as never)
    })
    expect(command).toHaveBeenCalledWith(ITEMS[1]) // started at 0 (Alpha), ArrowDown moved to 1 (Beta)
  })
})
```

### Step 2: Run, confirm failure

```
npx vitest run src/features/agent-chat/ComposerSuggestionMenu.test.tsx
```

Expected: fails with "Cannot find module '@/features/agent-chat/ComposerSuggestionMenu'".

### Step 3: Implement `ComposerSuggestionMenu.tsx`

Ported from `composerMention.ts`'s current `MentionMenu` (same highlight
state, arrow-key/Enter/Tab handling, `scrollIntoView` effect), generalized
over `Item extends ComposerSuggestionMenuItem` and given the error/empty
override branches:

```tsx
import type { MouseEvent, ReactNode, RefAttributes } from 'react'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion'
import { cn } from '@/lib/utils'

export interface ComposerSuggestionMenuItem {
  id: string
  label: string
  description?: string
  icon: LucideIcon
}

export interface ComposerSuggestionMenuProps<Item extends ComposerSuggestionMenuItem>
  extends SuggestionProps<Item, Item> {
  itemTestAttr: string
  errorMessage?: string | null
  emptyMessage?: string | null
}

export interface ComposerSuggestionMenuHandle {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean
}

const STATUS_ROW = 'z-[70] w-72 rounded-md border border-border bg-popover px-2 py-1.5 text-xs shadow-md'

function ComposerSuggestionMenuInner<Item extends ComposerSuggestionMenuItem>(
  { items, command, loading, itemTestAttr, errorMessage, emptyMessage }: ComposerSuggestionMenuProps<Item>,
  ref: React.ForwardedRef<ComposerSuggestionMenuHandle>,
): ReactNode {
  const [highlighted, setHighlighted] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => setHighlighted(0), [items])
  useEffect(() => {
    listRef.current?.children[highlighted]?.scrollIntoView({ block: 'nearest' })
  }, [highlighted])

  useImperativeHandle(ref, () => ({
    onKeyDown({ event }) {
      if (items.length === 0) return false
      if (event.key === 'ArrowDown') {
        setHighlighted((index) => (index + 1) % items.length)
        return true
      }
      if (event.key === 'ArrowUp') {
        setHighlighted((index) => (index - 1 + items.length) % items.length)
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        command(items[highlighted])
        return true
      }
      return false
    },
  }))

  if (errorMessage) {
    return <div className={cn(STATUS_ROW, 'text-destructive')}>{errorMessage}</div>
  }

  if (items.length === 0) {
    if (loading) return <div className={cn(STATUS_ROW, 'text-muted-foreground')}>Searching…</div>
    if (emptyMessage) return <div className={cn(STATUS_ROW, 'text-muted-foreground')}>{emptyMessage}</div>
    return null
  }

  return (
    <div
      ref={listRef}
      className="z-[70] flex max-h-72 w-72 flex-col overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-md"
    >
      {items.map((item, index) => {
        const testAttr = { [`data-${itemTestAttr}`]: item.id }
        return (
          <button
            key={item.id}
            type="button"
            {...testAttr}
            onMouseDown={(event: MouseEvent) => event.preventDefault()}
            onMouseEnter={() => setHighlighted(index)}
            onClick={() => command(item)}
            className={cn(
              'flex w-full cursor-pointer items-start gap-2 rounded-sm px-2 py-1 text-left text-sm text-foreground',
              index === highlighted ? 'bg-muted' : 'hover:bg-muted',
            )}
          >
            <item.icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{item.label}</span>
              {item.description ? (
                <span className="truncate text-xs text-muted-foreground">{item.description}</span>
              ) : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}
ComposerSuggestionMenuInner.displayName = 'ComposerSuggestionMenu'

// forwardRef + a generic component don't compose directly in TSX — the cast
// is the standard workaround (React's own forwardRef types are non-generic).
export const ComposerSuggestionMenu = forwardRef(ComposerSuggestionMenuInner) as <
  Item extends ComposerSuggestionMenuItem,
>(
  props: ComposerSuggestionMenuProps<Item> & RefAttributes<ComposerSuggestionMenuHandle>,
) => ReactNode
```

`text-destructive`/`border-border`/`bg-popover`/`text-muted-foreground` — the
same shadcn-style token family `composerMention.ts`'s current popup already
uses (not the `devdeck-*` tokens `ChatComposer.tsx`/`ComposerControls.tsx`
use); `--destructive` maps to `--devdeck-err` (`globals.css:208`), so this
stays on-palette without introducing a second token vocabulary into this file.

### Step 4: Run, confirm `ComposerSuggestionMenu.test.tsx` passes

```
npx vitest run src/features/agent-chat/ComposerSuggestionMenu.test.tsx
```

### Step 5: Rewrite `composerMention.ts` to use it, and fix `allowedPrefixes`

Delete the local `MentionMenu`, `MentionMenuHandle`, `MentionFileItem` and
`MentionRenderer` definitions (verified unused outside this file — nothing
else imports them). Replace with:

```ts
import { File, Folder } from 'lucide-react'
import type { RefAttributes } from 'react'
import { ComposerSuggestionMenu } from '@/features/agent-chat/ComposerSuggestionMenu'
import type {
  ComposerSuggestionMenuHandle,
  ComposerSuggestionMenuItem,
  ComposerSuggestionMenuProps,
} from '@/features/agent-chat/ComposerSuggestionMenu'

function toMenuItem(path: string): ComposerSuggestionMenuItem {
  return { id: path, label: path, icon: path.endsWith('/') ? Folder : File }
}

type MentionRenderer = ReactRenderer<
  ComposerSuggestionMenuHandle,
  ComposerSuggestionMenuProps<ComposerSuggestionMenuItem> & RefAttributes<ComposerSuggestionMenuHandle>
>

export function createComposerMention(machine: Machine, worktreeId: string, debounceMs = DEFAULT_MENTION_DEBOUNCE_MS) {
  return Extension.create({
    name: 'composerMention',
    addProseMirrorPlugins() {
      return [
        Suggestion<ComposerSuggestionMenuItem, ComposerSuggestionMenuItem>({
          editor: this.editor,
          pluginKey: mentionPluginKey,
          char: '@',
          allow: mentionAllow,
          // The fix: '\n' is what precedes a trigger typed on any line after
          // Shift+Enter (G's editor inserts a literal '\n' text character,
          // no hardBreak node — ComposerPromptEditor.tsx's own header).
          // Without this, findSuggestionMatch discards the match before
          // `allow` ever runs (@tiptap/suggestion/dist/index.js:646, default
          // allowedPrefixes = [' ']).
          allowedPrefixes: [' ', '\n'],
          debounce: debounceMs,
          items: async ({ query }) => {
            const results = await searchWorktreeFiles(machine, worktreeId, query, { includeDirs: true })
            return results.slice(0, MENTION_RESULT_LIMIT).map(toMenuItem)
          },
          command: ({ editor, range, props }) =>
            editor
              .chain()
              .focus()
              .insertContentAt(range, { type: composerChipNodeName('file'), attrs: { value: props.id } })
              .run(),
          render: () => {
            let component: MentionRenderer | null = null
            let unmount: (() => void) | null = null
            return {
              onStart(props) {
                component = new ReactRenderer(ComposerSuggestionMenu, {
                  props: { ...props, itemTestAttr: 'mention-item' },
                  editor: props.editor,
                })
                unmount = props.mount(component.element as HTMLElement)
              },
              onUpdate(props) {
                component?.updateProps({ ...props, itemTestAttr: 'mention-item' })
              },
              onKeyDown(props) {
                if (props.event.key === 'Escape') return false
                return component?.ref?.onKeyDown(props) ?? false
              },
              onExit() {
                unmount?.()
                unmount = null
                component?.destroy()
                component = null
              },
            }
          },
        }),
      ]
    },
  })
}
```

`isMentionWordStart` and `mentionAllow` are untouched — keep them exactly as
they are; D3 imports `mentionAllow` directly.

### Step 6: Run the regression gate

```
npx vitest run src/features/agent-chat/composerMention.test.ts
```

Expected: **passes, unmodified.** `data-mention-item="src/app.tsx"` still
resolves (item `id` = path, same as the old `item.path`); the inserted chip's
`attrs.value` is still `props.id` = the path. If this file needs a single-line
edit to pass, stop — the extraction changed behavior and needs to be
reconsidered before continuing, not patched around.

This step is also where D2's own `allowedPrefixes` fix gets its only
same-task check: `composerMention.test.ts`'s existing "start of doc" / "right
after whitespace" cases must still pass (they do — the fix only *adds* `'\n'`
to the allowed set, it doesn't remove `' '` or `''`). The **failing-first
regression proof** for the `\n` bug itself — typing `@` immediately after a
real Shift+Enter dispatch — needs the fully assembled editor (submit keymap +
literal `\n` insertion), which doesn't exist until D5; that test is written
there. See D5's Step 1 for the explicit spike sequence that keeps it honestly
failing-first despite landing in a later task.

**Done when:** `ComposerSuggestionMenu.test.tsx` is green, and
`composerMention.test.ts` is green **with zero diff against its current
content**.

---

## D3 — `$` skill trigger (needs D2, parallel with D4)

**Files:**
- Create: `composerSkillTrigger.ts`
- Create: `composerSkillTrigger.test.ts`

**Interfaces:**
- Consumes: `ComposerSuggestionMenu`, `ComposerSuggestionMenuItem` (D2);
  `mentionAllow` (D2, re-exported unchanged from `composerMention.ts`);
  `composerChipNodeName` (already exists, `composerNodes.ts:57`); `AgentSkill`
  (`@/store/types`).
- Produces (for D5 to consume):
  ```ts
  export interface SkillCatalogSnapshot {
    status: 'loading' | 'ready' | 'error'
    skills: AgentSkill[]
    agentId: string
  }
  export function matchSkills(skills: AgentSkill[], query: string): AgentSkill[]
  export function createComposerSkillTrigger(snapshot: { current: SkillCatalogSnapshot }): Extension
  ```

### Step 1: Write the failing tests

Pure matcher, no DOM:

```ts
import { describe, expect, it } from 'vitest'
import { matchSkills } from '@/features/agent-chat/composerSkillTrigger'
import type { AgentSkill } from '@/store/types'

function skill(name: string, description = ''): AgentSkill {
  return { name, description, category: 'general', readOnly: false }
}

describe('matchSkills', () => {
  it('returns everything, sorted by name, when the query is empty', () => {
    const skills = [skill('zeta'), skill('alpha'), skill('mu')]
    expect(matchSkills(skills, '').map((s) => s.name)).toEqual(['alpha', 'mu', 'zeta'])
  })

  it('puts prefix hits ahead of contains hits', () => {
    const skills = [skill('code-review'), skill('review-notes'), skill('data-report')]
    expect(matchSkills(skills, 'review').map((s) => s.name)).toEqual(['review-notes', 'code-review'])
  })

  it('matches on description too', () => {
    const skills = [skill('foo', 'reviews pull requests'), skill('bar', 'unrelated')]
    expect(matchSkills(skills, 'review').map((s) => s.name)).toEqual(['foo'])
  })

  it('caps results at 20', () => {
    const skills = Array.from({ length: 25 }, (_, i) => skill(`skill-${String(i).padStart(2, '0')}`))
    expect(matchSkills(skills, '')).toHaveLength(20)
  })
})
```

Component-level, mounted editor (same harness technique as
`composerMention.test.ts`'s `TestEditorHost` — `useEditor`/`EditorContent`,
since node-view rendering needs the real portal registry):

```ts
import { createElement, useEffect } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { Node, getSchema } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor } from '@tiptap/react'
import type { AgentSkill } from '@/store/types'
import { ComposerFileChip, ComposerSkillChip, ComposerTerminalContextChip } from '@/features/agent-chat/composerNodes'
import { createComposerSkillTrigger } from '@/features/agent-chat/composerSkillTrigger'
import type { SkillCatalogSnapshot } from '@/features/agent-chat/composerSkillTrigger'

afterEach(cleanup)

const TestDocument = Node.create({ name: 'doc', topNode: true, content: 'inline*' })
const TestText = Node.create({ name: 'text', group: 'inline' })
const schema = getSchema([TestDocument, TestText])

function skill(name: string, description = ''): AgentSkill {
  return { name, description, category: 'general', readOnly: false }
}

function TestEditorHost({
  snapshot,
  onEditor,
}: {
  snapshot: { current: SkillCatalogSnapshot }
  onEditor: (editor: Editor) => void
}) {
  const editor = useEditor({
    extensions: [TestDocument, TestText, ComposerFileChip, ComposerSkillChip, ComposerTerminalContextChip, createComposerSkillTrigger(snapshot)],
    content: { type: 'doc', content: [{ type: 'text', text: 'hello ' }] },
  })
  useEffect(() => {
    if (editor) onEditor(editor)
  }, [editor, onEditor])
  return createElement(EditorContent, { editor })
}

describe('createComposerSkillTrigger — catalog states', () => {
  it('shows Searching… while the catalog is loading', async () => {
    const snapshot = { current: { status: 'loading', skills: [], agentId: 'claude' } as SkillCatalogSnapshot }
    let editor: Editor | null = null
    render(createElement(TestEditorHost, { snapshot, onEditor: (e) => (editor = e) }))
    await waitFor(() => expect(editor).not.toBeNull())
    editor!.commands.focus('end')
    editor!.commands.insertContent('$rev')
    await waitFor(() => expect(document.querySelector('[data-skill-item]')).toBeNull())
    expect(document.body.textContent).toContain('Searching…')
  })

  it("shows the agent-scoped error message when the catalog failed to load", async () => {
    const snapshot = { current: { status: 'error', skills: [], agentId: 'claude' } as SkillCatalogSnapshot }
    let editor: Editor | null = null
    render(createElement(TestEditorHost, { snapshot, onEditor: (e) => (editor = e) }))
    await waitFor(() => expect(editor).not.toBeNull())
    editor!.commands.focus('end')
    editor!.commands.insertContent('$rev')
    await waitFor(() => expect(document.body.textContent).toContain("Couldn't load skills for claude"))
  })

  it('shows "No skills found" for a ready catalog with no matches', async () => {
    const snapshot = {
      current: { status: 'ready', skills: [skill('code-review')], agentId: 'claude' } as SkillCatalogSnapshot,
    }
    let editor: Editor | null = null
    render(createElement(TestEditorHost, { snapshot, onEditor: (e) => (editor = e) }))
    await waitFor(() => expect(editor).not.toBeNull())
    editor!.commands.focus('end')
    editor!.commands.insertContent('$nonexistent')
    await waitFor(() => expect(document.body.textContent).toContain('No skills found'))
  })
})

describe('createComposerSkillTrigger — selection', () => {
  it('selecting a skill inserts a composerSkillChip with the exact skill name as value', async () => {
    const snapshot = {
      current: { status: 'ready', skills: [skill('code-review', 'Reviews a PR')], agentId: 'claude' } as SkillCatalogSnapshot,
    }
    let editor: Editor | null = null
    render(createElement(TestEditorHost, { snapshot, onEditor: (e) => (editor = e) }))
    await waitFor(() => expect(editor).not.toBeNull())
    editor!.commands.focus('end')
    editor!.commands.insertContent('$code')
    await waitFor(() => expect(document.querySelector('[data-skill-item="code-review"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-skill-item="code-review"]') as HTMLButtonElement)
    await waitFor(() => {
      const content = editor!.getJSON().content ?? []
      expect(content.some((n) => n.type === 'composerSkillChip' && n.attrs?.value === 'code-review')).toBe(true)
    })
    expect(editor!.getText()).not.toContain('$code')
  })

  it('$ does not open the menu mid-word (reuses mentionAllow — word-start rule)', async () => {
    const snapshot = { current: { status: 'ready', skills: [skill('review')], agentId: 'claude' } as SkillCatalogSnapshot }
    let editor: Editor | null = null
    render(createElement(TestEditorHost, { snapshot, onEditor: (e) => (editor = e) }))
    await waitFor(() => expect(editor).not.toBeNull())
    editor!.commands.focus('end')
    editor!.commands.insertContent('foo$review') // '$' preceded by 'o', not whitespace
    expect(document.querySelector('[data-skill-item]')).toBeNull()
  })
})
```

### Step 2: Run, confirm failure

```
npx vitest run src/features/agent-chat/composerSkillTrigger.test.ts
```

Expected: "Cannot find module '@/features/agent-chat/composerSkillTrigger'".

### Step 3: Implement

```ts
import { Box } from 'lucide-react'
import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { ReactRenderer } from '@tiptap/react'
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion'
import type { RefAttributes } from 'react'

import type { AgentSkill } from '@/store/types'
import { mentionAllow } from '@/features/agent-chat/composerMention'
import { composerChipNodeName } from '@/features/agent-chat/composerNodes'
import { ComposerSuggestionMenu } from '@/features/agent-chat/ComposerSuggestionMenu'
import type { ComposerSuggestionMenuHandle, ComposerSuggestionMenuItem, ComposerSuggestionMenuProps } from '@/features/agent-chat/ComposerSuggestionMenu'

const skillPluginKey = new PluginKey('composerSkillTrigger')
const SKILL_RESULT_LIMIT = 20

export interface SkillCatalogSnapshot {
  status: 'loading' | 'ready' | 'error'
  skills: AgentSkill[]
  agentId: string
}

function byName(a: AgentSkill, b: AgentSkill): number {
  return a.name.localeCompare(b.name)
}

/** Prefix hits before contains hits (name or description), each bucket
 *  sorted by name, capped at SKILL_RESULT_LIMIT. Not t3code's
 *  `searchProviderSkills` — this repo's `AgentSkill` has no
 *  shortDescription/scope/displayName/enabled to rank against
 *  (spec §3). */
export function matchSkills(skills: AgentSkill[], query: string): AgentSkill[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return [...skills].sort(byName).slice(0, SKILL_RESULT_LIMIT)

  const prefix: AgentSkill[] = []
  const contains: AgentSkill[] = []
  for (const s of skills) {
    const name = s.name.toLowerCase()
    if (name.startsWith(needle)) prefix.push(s)
    else if (name.includes(needle) || s.description.toLowerCase().includes(needle)) contains.push(s)
  }
  return [...prefix.sort(byName), ...contains.sort(byName)].slice(0, SKILL_RESULT_LIMIT)
}

function toMenuItem(skill: AgentSkill): ComposerSuggestionMenuItem {
  return { id: skill.name, label: skill.name, description: skill.description, icon: Box }
}

type SkillRenderer = ReactRenderer<
  ComposerSuggestionMenuHandle,
  ComposerSuggestionMenuProps<ComposerSuggestionMenuItem> & RefAttributes<ComposerSuggestionMenuHandle>
>

export function createComposerSkillTrigger(snapshot: { current: SkillCatalogSnapshot }) {
  return Extension.create({
    name: 'composerSkillTrigger',
    addProseMirrorPlugins() {
      return [
        Suggestion<ComposerSuggestionMenuItem, ComposerSuggestionMenuItem>({
          editor: this.editor,
          pluginKey: skillPluginKey,
          char: '$',
          allow: mentionAllow,
          allowedPrefixes: [' ', '\n'],
          items: ({ query }) =>
            snapshot.current.status === 'ready' ? matchSkills(snapshot.current.skills, query).map(toMenuItem) : [],
          command: ({ editor, range, props }) =>
            editor
              .chain()
              .focus()
              .insertContentAt(range, { type: composerChipNodeName('skill'), attrs: { value: props.id } })
              .run(),
          render: () => {
            let component: SkillRenderer | null = null
            let unmount: (() => void) | null = null

            function extend(props: SuggestionProps<ComposerSuggestionMenuItem, ComposerSuggestionMenuItem>) {
              const snap = snapshot.current
              return {
                ...props,
                loading: snap.status === 'loading',
                errorMessage: snap.status === 'error' ? `Couldn't load skills for ${snap.agentId}` : null,
                emptyMessage: 'No skills found',
                itemTestAttr: 'skill-item',
              }
            }

            return {
              onStart(props) {
                component = new ReactRenderer(ComposerSuggestionMenu, { props: extend(props), editor: props.editor })
                unmount = props.mount(component.element as HTMLElement)
              },
              onUpdate(props) {
                component?.updateProps(extend(props))
              },
              onKeyDown(props) {
                if (props.event.key === 'Escape') return false
                return component?.ref?.onKeyDown(props) ?? false
              },
              onExit() {
                unmount?.()
                unmount = null
                component?.destroy()
                component = null
              },
            }
          },
        }),
      ]
    },
  })
}
```

Note: `items()` here overrides tiptap's own `loading`/error inference (it
always resolves synchronously and never throws), which is why `extend()`
substitutes `snapshot.current.status` for tiptap's `loading` prop rather than
trusting it — the catalog's real network fetch already happened in
`useAgentSkills` (D5), before any keystroke; `items()` only ever filters an
already-resolved (or not-yet-resolved) local array.

### Step 4: Run, confirm pass

```
npx vitest run src/features/agent-chat/composerSkillTrigger.test.ts
```

**Done when:** `composerSkillTrigger.test.ts` is green, and
`composerMention.test.ts` (read, not written by this task) is still
untouched and green.

---

## D4 — `/` slash trigger (needs D2, parallel with D3)

**Files:**
- Create: `composerSlashTrigger.ts`
- Create: `composerSlashTrigger.test.ts`

**Interfaces:**
- Consumes: `ComposerSuggestionMenu`, `ComposerSuggestionMenuItem` (D2);
  `InteractionMode` (`@/features/agent-chat/useAgentChatSocket`, unchanged,
  read-only).
- Produces (for D5):
  ```ts
  export interface BuiltInSlashCommand {
    id: string
    label: string
    description: string
    keywords?: string[]
    mode: InteractionMode
  }
  export const BUILT_IN_COMMANDS: BuiltInSlashCommand[]
  export function matchSlashCommands(query: string): BuiltInSlashCommand[]
  export function createComposerSlashTrigger(
    onInteractionModeChangeRef: { current: (mode: InteractionMode) => void },
  ): Extension
  ```

Two commands only, per spec's Non-goals: `/plan` → `setInteractionMode('plan')`,
`/build` → `setInteractionMode('default')` (DevDeck's own word for
`InteractionMode.default`, `'default'` kept as a matching keyword for t3code
muscle memory).

### Step 1: Write the failing tests

Pure, no DOM:

```ts
import { describe, expect, it } from 'vitest'
import { BUILT_IN_COMMANDS, matchSlashCommands } from '@/features/agent-chat/composerSlashTrigger'

describe('BUILT_IN_COMMANDS', () => {
  it('has exactly /plan and /build, mapped to the right InteractionMode', () => {
    expect(BUILT_IN_COMMANDS.map((c) => [c.id, c.mode])).toEqual([
      ['plan', 'plan'],
      ['build', 'default'],
    ])
  })
})

describe('matchSlashCommands', () => {
  it('returns both commands for an empty query', () => {
    expect(matchSlashCommands('').map((c) => c.id)).toEqual(['plan', 'build'])
  })

  it('matches /build on the "default" keyword (t3code muscle memory)', () => {
    expect(matchSlashCommands('default').map((c) => c.id)).toEqual(['build'])
  })

  it('matches on label substring', () => {
    expect(matchSlashCommands('pl').map((c) => c.id)).toEqual(['plan'])
  })
})
```

Component-level, `slashLineStartAllow` and full selection flow (own
`TestEditorHost`, mirroring D3's):

```ts
import { EditorState } from '@tiptap/pm/state'
import { Node, getSchema } from '@tiptap/core'
import { slashLineStartAllow } from '@/features/agent-chat/composerSlashTrigger'

const TestDocument = Node.create({ name: 'doc', topNode: true, content: 'inline*' })
const TestText = Node.create({ name: 'text', group: 'inline' })
const schema = getSchema([TestDocument, TestText])

describe('slashLineStartAllow', () => {
  it('fires at the very start of the document', () => {
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.text('/')]) })
    expect(slashLineStartAllow({ state, range: { from: 0, to: 1 } })).toBe(true)
  })

  it('fires right after a literal newline (Shift+Enter continuation line)', () => {
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.text('x\n/')]) })
    expect(slashLineStartAllow({ state, range: { from: 2, to: 3 } })).toBe(true)
  })

  it('does not fire mid-sentence, as in "fix the /plan thing"', () => {
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.text('fix the /plan thing')]) })
    // '/' at index 8, preceded by a space — NOT start of line, so this must be false.
    expect(slashLineStartAllow({ state, range: { from: 8, to: 13 } })).toBe(false)
  })

  it('does not fire inside a URL path, as in "https://host/path"', () => {
    const state = EditorState.create({ schema, doc: schema.node('doc', null, [schema.text('https://host/path')]) })
    // The '/' before "path" is at index 12 (text.lastIndexOf('/') === 12),
    // preceded by 't' — NOT start of line, so this must be false.
    expect(slashLineStartAllow({ state, range: { from: 12, to: 17 } })).toBe(false)
  })
})
```

And the selection flow, same harness shape as D3/`composerMention.test.ts`:

```ts
it('typing /pl and selecting /plan calls the callback with "plan" and inserts nothing', async () => {
  const onInteractionModeChange = vi.fn()
  const ref = { current: onInteractionModeChange }
  let editor: Editor | null = null
  render(createElement(TestEditorHost, { ref, onEditor: (e) => (editor = e) }))
  await waitFor(() => expect(editor).not.toBeNull())
  editor!.commands.focus('end')
  editor!.commands.insertContent('/pl')
  await waitFor(() => expect(document.querySelector('[data-command-item="plan"]')).not.toBeNull())
  fireEvent.click(document.querySelector('[data-command-item="plan"]') as HTMLButtonElement)
  await waitFor(() => expect(onInteractionModeChange).toHaveBeenCalledWith('plan'))
  expect(editor!.getText()).toBe('')
})
```

### Step 2: Run, confirm failure

```
npx vitest run src/features/agent-chat/composerSlashTrigger.test.ts
```

### Step 3: Implement

```ts
import { Hammer } from 'lucide-react'
import { Extension } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import { PluginKey } from '@tiptap/pm/state'
import { ReactRenderer } from '@tiptap/react'
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion'
import type { RefAttributes } from 'react'

import type { InteractionMode } from '@/features/agent-chat/useAgentChatSocket'
import { ComposerSuggestionMenu } from '@/features/agent-chat/ComposerSuggestionMenu'
import type { ComposerSuggestionMenuHandle, ComposerSuggestionMenuItem, ComposerSuggestionMenuProps } from '@/features/agent-chat/ComposerSuggestionMenu'

const slashPluginKey = new PluginKey('composerSlashTrigger')

export interface BuiltInSlashCommand {
  id: string
  label: string
  description: string
  keywords?: string[]
  mode: InteractionMode
}

// Icon: Hammer for both — the same icon ComposerControls.tsx's own
// interaction-mode pill already uses (`Pill icon={Hammer}`), no new icon
// vocabulary introduced for two rows.
export const BUILT_IN_COMMANDS: BuiltInSlashCommand[] = [
  { id: 'plan', label: '/plan', description: 'Switch this thread to Plan mode', keywords: ['plan'], mode: 'plan' },
  {
    id: 'build',
    label: '/build',
    description: 'Switch this thread to Build mode',
    keywords: ['default', 'build'],
    mode: 'default',
  },
]

export function matchSlashCommands(query: string): BuiltInSlashCommand[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return BUILT_IN_COMMANDS
  return BUILT_IN_COMMANDS.filter(
    (cmd) =>
      cmd.label.toLowerCase().includes(needle) ||
      cmd.description.toLowerCase().includes(needle) ||
      cmd.keywords?.some((k) => k.includes(needle)),
  )
}

function toMenuItem(cmd: BuiltInSlashCommand): ComposerSuggestionMenuItem {
  return { id: cmd.id, label: cmd.label, description: cmd.description, icon: Hammer }
}

/** '/' is line-start, not word-start (spec §4): `fix the /plan thing` and
 *  `https://host/path` must not open the menu. Reads the character before
 *  `range.from` directly rather than `@tiptap/suggestion`'s own
 *  `startOfLine` option, which anchors `^` against
 *  `$position.nodeBefore.text` and would misfire right after a chip atom
 *  (spec §4's explicit reasoning). */
export function slashLineStartAllow({ state, range }: { state: EditorState; range: { from: number; to: number } }): boolean {
  const { from } = range
  const charBefore = from > 0 ? state.doc.textBetween(from - 1, from, '\n', '\n') : ''
  return charBefore.length === 0 || charBefore === '\n'
}

type SlashRenderer = ReactRenderer<
  ComposerSuggestionMenuHandle,
  ComposerSuggestionMenuProps<ComposerSuggestionMenuItem> & RefAttributes<ComposerSuggestionMenuHandle>
>

export function createComposerSlashTrigger(onInteractionModeChangeRef: { current: (mode: InteractionMode) => void }) {
  return Extension.create({
    name: 'composerSlashTrigger',
    addProseMirrorPlugins() {
      return [
        Suggestion<ComposerSuggestionMenuItem, ComposerSuggestionMenuItem>({
          editor: this.editor,
          pluginKey: slashPluginKey,
          char: '/',
          allow: slashLineStartAllow,
          allowedPrefixes: [' ', '\n'],
          items: ({ query }) => matchSlashCommands(query).map(toMenuItem),
          command: ({ editor, range, props }) => {
            const found = BUILT_IN_COMMANDS.find((cmd) => cmd.id === props.id)
            // No node insertion — a command is an action, not a reference
            // (spec §2: "/ inserts no node, which is why G defined only
            // three chip types").
            editor.chain().focus().deleteRange(range).run()
            if (found) onInteractionModeChangeRef.current(found.mode)
          },
          render: () => {
            let component: SlashRenderer | null = null
            let unmount: (() => void) | null = null

            function extend(props: SuggestionProps<ComposerSuggestionMenuItem, ComposerSuggestionMenuItem>) {
              return { ...props, itemTestAttr: 'command-item' }
            }

            return {
              onStart(props) {
                component = new ReactRenderer(ComposerSuggestionMenu, { props: extend(props), editor: props.editor })
                unmount = props.mount(component.element as HTMLElement)
              },
              onUpdate(props) {
                component?.updateProps(extend(props))
              },
              onKeyDown(props) {
                if (props.event.key === 'Escape') return false
                return component?.ref?.onKeyDown(props) ?? false
              },
              onExit() {
                unmount?.()
                unmount = null
                component?.destroy()
                component = null
              },
            }
          },
        }),
      ]
    },
  })
}
```

The built-in list is static and never empty/errors, so no `emptyMessage`/
`errorMessage` override is needed here — the default (render `null` when
`items.length === 0`) is already correct, since a non-matching query for a
2-item static list closing silently is fine (unlike skills, there's no
"catalog failed to load" state to report for an in-module array).

### Step 4: Run, confirm pass

```
npx vitest run src/features/agent-chat/composerSlashTrigger.test.ts
```

**Done when:** `composerSlashTrigger.test.ts` is green.

---

## D5 — Wire into `ComposerPromptEditor` (needs D1, D2, D3, D4)

The convergence task: assembles all four into the real editor, and is where
the two cross-cutting risks from the spec actually get proven — Enter
priority across three suggestion plugins now, and the `\n`-prefix regression.

**A resolved ambiguity, stated up front.** The spec's §5 first says
`ComposerPromptEditor` "gains three props: `agentId`, `skills` and
`onInteractionModeChange`," then two paragraphs later says `useAgentSkills`
"is called in `ComposerPromptEditor` … and passed down as `skills`" — i.e.
`skills` is derived *inside* the component from `agentId`, not received as an
external prop (this is also the only reading under which `AgentChatPane.tsx`
truly stays unmodified — nothing above `ChatComposer` would otherwise have any
reason to call `useAgentSkills`). This plan follows the second, internally
consistent reading: **two** new external props (`agentId`,
`onInteractionModeChange`); `skills`/`SkillCatalogSnapshot` is a local variable
built from `useAgentSkills(machine, agentId)`.

**Files:**
- Modify: `ComposerPromptEditor.tsx`
- Modify: `ComposerPromptEditor.test.tsx`

**Interfaces:**
- Consumes: `serializeComposerDoc`/`composerSkillChip` behavior (D1, via the
  existing `composerChipNodeToChip` bridge — no direct import changes needed
  there); `createComposerMention` (D2, already imported, now with the
  `allowedPrefixes` fix baked in); `createComposerSkillTrigger`,
  `SkillCatalogSnapshot` (D3); `createComposerSlashTrigger`,
  `BUILT_IN_COMMANDS`'s `InteractionMode` shape (D4); `useAgentSkills`
  (`@/features/data/queries`, pre-existing, unmodified).
- Produces (for D6): two new required props,
  `agentId: string` and `onInteractionModeChange: (mode: InteractionMode) => void`.

### Step 1: Write the failing tests

Add a mock for `useAgentSkills` — this file currently mocks only
`@/lib/machineApi`, so this is the "one stub line" exception the spec calls
out (its own Testing section): introducing `useAgentSkills` anywhere in the
composer subtree requires either a `QueryClientProvider` or a mock in every
test file that mounts it, and a mock is the lighter touch already used
elsewhere in this suite (`ChatComposer.test.tsx`, `AgentChatPane.test.tsx`).

```ts
vi.mock('@/features/data/queries', () => ({
  useAgentSkills: vi.fn(),
}))
import { useAgentSkills } from '@/features/data/queries'
const useAgentSkillsMock = vi.mocked(useAgentSkills)

// Default: a ready catalog with one skill, unless a test overrides it.
beforeEach(() => {
  useAgentSkillsMock.mockReturnValue({
    data: [{ name: 'code-review', description: 'Reviews a PR', category: 'general', readOnly: false }],
    isLoading: false,
    error: null,
  } as never)
})
```

`renderEditor`'s default props gain `agentId: 'claude'` and
`onInteractionModeChange: vi.fn()`.

New test cases:

```ts
describe('ComposerPromptEditor — $ skill menu', () => {
  it('typing $ opens the menu; selecting inserts a chip serialized to the bracketed form', async () => {
    const { dom, onChange } = renderEditor()
    paste(dom, '$code')
    await waitFor(() => expect(document.querySelector('[data-skill-item="code-review"]')).not.toBeNull())
    fireEvent.click(document.querySelector('[data-skill-item="code-review"]') as HTMLButtonElement)
    await waitFor(() => expect(lastChange(onChange)).toContain('[$code-review](skill:code-review)'))
  })

  it('Enter with the skill menu open selects an item and does NOT submit', async () => {
    const { dom, onSubmit } = renderEditor()
    paste(dom, '$code')
    await waitFor(() => expect(document.querySelector('[data-skill-item="code-review"]')).not.toBeNull())
    fireEvent.keyDown(dom, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('renders the three catalog states', async () => {
    useAgentSkillsMock.mockReturnValue({ data: undefined, isLoading: true, error: null } as never)
    const { dom, rerender } = renderEditor()
    paste(dom, '$x')
    await waitFor(() => expect(document.body.textContent).toContain('Searching…'))

    useAgentSkillsMock.mockReturnValue({ data: undefined, isLoading: false, error: new Error('boom') } as never)
    rerender(createElement(ComposerPromptEditor, { value: '$x', onChange: vi.fn(), onSubmit: vi.fn(), machine: FAKE_MACHINE, worktreeId: 'worktree-1', agentId: 'claude', onInteractionModeChange: vi.fn() }))
    await waitFor(() => expect(document.body.textContent).toContain("Couldn't load skills for claude"))
  })
})

describe('ComposerPromptEditor — / command menu', () => {
  it('typing /pl and pressing Enter calls onInteractionModeChange("plan"), sends nothing, leaves the doc empty', async () => {
    const onInteractionModeChange = vi.fn()
    const { dom, onSubmit, onChange } = renderEditor({ onInteractionModeChange })
    paste(dom, '/pl')
    await waitFor(() => expect(document.querySelector('[data-command-item="plan"]')).not.toBeNull())
    fireEvent.keyDown(dom, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(onInteractionModeChange).toHaveBeenCalledWith('plan')
    await waitFor(() => expect(lastChange(onChange)).toBe(''))
  })
})
```

**The Problem §3 regression test — written as an honest failing-first spike.**
D2 already merged the `allowedPrefixes` fix before this task starts, so this
test would pass on first run without proving anything. Do the spike the
spec's own Risks section describes doing for the Enter-priority ordering:

```ts
it('@ after Shift+Enter opens the mention menu (regression: Problem §3)', async () => {
  const { dom } = renderEditor()
  fireEvent.keyDown(dom, { key: 'Enter', shiftKey: true }) // literal '\n' before the next char
  paste(dom, '@app')
  await waitFor(() => expect(searchWorktreeFilesMock).toHaveBeenCalled())
})
```

1. Temporarily comment out `allowedPrefixes: [' ', '\n']` in
   `composerMention.ts` (revert to the implicit default).
2. Run this one test — confirm it fails (`searchWorktreeFilesMock` never
   called; the match is discarded before `allow` runs).
3. Restore the `allowedPrefixes` line.
4. Run again — confirm it passes.

Record in the commit body (or a comment above the test) that this spike was
performed, mirroring the spec's own precedent for the Enter-priority check.

### Step 2: Run, confirm the new tests fail (before implementation)

```
npx vitest run src/features/agent-chat/ComposerPromptEditor.test.tsx
```

Expected: fails — `agentId`/`onInteractionModeChange` don't exist yet, no
`$`/`/` extensions are registered.

### Step 3: Implement

Add two props, call `useAgentSkills`, build the catalog ref, add the two new
extensions after `createComposerMention` (order among the three triggers is
irrelevant per spec §5 — `@tiptap/suggestion`'s `handleKeyDown` only
intercepts when its own plugin is active and the three `char`s are mutually
exclusive at any cursor):

```ts
import { useAgentSkills } from '@/features/data/queries'
import type { InteractionMode } from '@/features/agent-chat/useAgentChatSocket'
import { createComposerSkillTrigger } from '@/features/agent-chat/composerSkillTrigger'
import type { SkillCatalogSnapshot } from '@/features/agent-chat/composerSkillTrigger'
import { createComposerSlashTrigger } from '@/features/agent-chat/composerSlashTrigger'

export interface ComposerPromptEditorProps {
  // ...existing fields unchanged...
  agentId: string
  onInteractionModeChange: (mode: InteractionMode) => void
}

export function ComposerPromptEditor({
  value,
  onChange,
  onSubmit,
  placeholder,
  disabled = false,
  machine,
  worktreeId,
  agentId,
  onInteractionModeChange,
}: ComposerPromptEditorProps) {
  // ...existing refs (onChangeRef, keymapSnapshot, initialValue, lastValue)...

  const { data: skillsData, isLoading: skillsLoading, error: skillsError } = useAgentSkills(machine, agentId)
  const skillCatalog = useRef<SkillCatalogSnapshot>({ status: 'loading', skills: [], agentId })
  skillCatalog.current = {
    status: skillsError ? 'error' : skillsLoading ? 'loading' : 'ready',
    skills: skillsData ?? [],
    agentId,
  }

  const onInteractionModeChangeRef = useRef(onInteractionModeChange)
  onInteractionModeChangeRef.current = onInteractionModeChange

  const editor = useEditor(
    {
      extensions: [
        ComposerDocument,
        Text,
        ...composerChipNodes,
        UndoRedo,
        createComposerSubmitKeymap(keymapSnapshot),
        createComposerMention(machine, worktreeId),
        createComposerSkillTrigger(skillCatalog),
        createComposerSlashTrigger(onInteractionModeChangeRef),
      ],
      // ...unchanged content/editable/editorProps/onUpdate...
    },
    // Unchanged deps — agentId changes flow through the ref, not a rebuild
    // (spec's own Risks note: a rebuild here would reset undo history on
    // every model-picker switch).
    [machine.id, worktreeId],
  )

  // ...unchanged remainder...
}
```

`toComposerInlineNode`/`toComposerDoc` need no change — `composerChipNodeToChip`
already handles all three chip kinds (base plan's T3), so a newly-inserted
`composerSkillChip` node serializes correctly through D1's fixed
`serializeInlineNode` with zero further wiring.

### Step 4: Run, confirm pass

```
npx vitest run src/features/agent-chat/ComposerPromptEditor.test.tsx
```

**Done when:** `ComposerPromptEditor.test.tsx` is green, including the spiked
regression test (spike performed and reverted per Step 1), and
`npm run typecheck` is clean.

---

## D6 — `ChatComposer` wiring (needs D5)

**Files:**
- Modify: `ChatComposer.tsx`
- Modify: `ChatComposer.test.tsx`
- Modify: `AgentChatPane.test.tsx`

`AgentChatPane.tsx` itself is **not modified** — per spec §5, everything D
needs is already inside `controls` (`worktreeAgentId`, `model`,
`setInteractionMode`), all populated at `AgentChatPane.tsx:151/148/158-161`
today.

**Interfaces:**
- Consumes: `ComposerPromptEditorProps.agentId`/`onInteractionModeChange` (D5).
- Produces: nothing new for a later task — this is the last task in the
  chain.

### Step 1: Write the failing tests

Add `useAgentSkills` to `ChatComposer.test.tsx`'s existing whole-module mock
of `@/features/data/queries` (it already stubs `useAgents`/`useAgentModels`
there):

```ts
vi.mock('@/features/data/queries', () => ({
  useAgents: () => ({ data: [{ id: 'claude', name: 'Claude', installed: true }], isLoading: false, error: null }),
  useAgentModels: () => ({ data: [{ id: 'claude-sonnet-5', name: 'Sonnet 5', contextWindow: 200000 }], isLoading: false, error: null }),
  useAgentSkills: vi.fn(() => ({ data: [], isLoading: false, error: null })),
}))
import { useAgentSkills } from '@/features/data/queries'
const useAgentSkillsMock = vi.mocked(useAgentSkills)
```

New tests — genuinely new logic in `ChatComposer.tsx` (the agent-id
derivation), plus a thin end-to-end proof that `/plan` reaches
`controls.setInteractionMode` (the deep skill/command menu behavior itself
stays owned by D5's `ComposerPromptEditor.test.tsx`, matching how this file
never re-tests `@` mention internals either):

```ts
it('derives the skill catalog agent id from the picked model, not the worktree default', () => {
  render(
    <ChatComposer
      status="idle"
      onSend={vi.fn()}
      onAbort={vi.fn()}
      controls={{ ...controls, worktreeAgentId: 'claude', model: { agentId: 'codex', modelId: 'x', modelName: 'X' } }}
      machine={{ id: 'm1', name: 'dev', url: '', key: '', isLocal: false, signingPublicKey: '' }}
      worktreeId="worktree-1"
    />,
  )
  expect(useAgentSkillsMock).toHaveBeenLastCalledWith(expect.anything(), 'codex')
})

it('falls back to the worktree default agent id when no model is picked', () => {
  render(
    <ChatComposer
      status="idle"
      onSend={vi.fn()}
      onAbort={vi.fn()}
      controls={{ ...controls, worktreeAgentId: 'claude', model: null }}
      machine={{ id: 'm1', name: 'dev', url: '', key: '', isLocal: false, signingPublicKey: '' }}
      worktreeId="worktree-1"
    />,
  )
  expect(useAgentSkillsMock).toHaveBeenLastCalledWith(expect.anything(), 'claude')
})

it('typing /plan and pressing Enter dispatches setInteractionMode("plan") and sends nothing', async () => {
  const onSend = vi.fn()
  const setInteractionMode = vi.fn()
  render(<ChatComposer status="idle" onSend={onSend} onAbort={vi.fn()} controls={{ ...controls, setInteractionMode }} />)
  const box = screen.getByRole('textbox')
  type(box, '/plan')
  pressEnter(box)
  expect(setInteractionMode).toHaveBeenCalledWith('plan')
  expect(onSend).not.toHaveBeenCalled()
  expect(box.textContent).toBe('')
})
```

`AgentChatPane.test.tsx` gets a **mock stub only** — add `useAgentSkills` to
its existing `vi.mock('@/features/data/queries', ...)` block (`:42-45`):

```ts
vi.mock('@/features/data/queries', () => ({
  useAgents: () => ({ data: [], isLoading: false, error: null }),
  useAgentModels: () => ({ data: [], isLoading: false, error: null }),
  useAgentSkills: () => ({ data: [], isLoading: false, error: null }),
}))
```

No new test cases in this file — `AgentChatPane.tsx` has no new behavior;
this edit exists purely to keep its existing suite passing once
`useAgentSkills` is called transitively through the render tree.

### Step 2: Run, confirm the new tests fail

```
npx vitest run src/features/agent-chat/ChatComposer.test.tsx
```

Expected: fails — `ComposerPromptEditor`'s required `agentId`/
`onInteractionModeChange` props are missing (TypeScript would also catch this
at `npm run typecheck`, but the runtime test is what the harness actually
runs).

### Step 3: Implement

```ts
export function ChatComposer({
  status,
  onSend,
  onAbort,
  machine,
  worktreeId,
  worktree,
  branch,
  controls,
  variant = 'docked',
}: ChatComposerProps) {
  // ...existing text/hero/chatStatus/draft/interrupting logic unchanged...

  // The effective agent for the next turn — the model picker can move a
  // thread to a different agent (ModelPicker.tsx:50-55), and the skill
  // catalog must follow whichever agent will actually run, not the
  // worktree's static default (spec §5).
  const agentId = controls.model?.agentId ?? controls.worktreeAgentId

  return (
    // ...unchanged JSX up to <ComposerPromptEditor>...
    <ComposerPromptEditor
      value={text}
      onChange={setText}
      onSubmit={submit}
      placeholder={hero ? 'Ask for changes, or describe what to build' : 'Ask anything…'}
      machine={machine ?? NO_MACHINE}
      worktreeId={worktreeId ?? ''}
      agentId={agentId}
      onInteractionModeChange={controls.setInteractionMode}
    />
    // ...unchanged footer...
  )
}
```

No other change to `ChatComposer.tsx` — the `BOX` constant, action-button
logic, and `@container/composer` dual render are all pre-existing and
untouched.

### Step 4: Run, confirm pass, then run the full regression set

```
npx vitest run src/features/agent-chat/ChatComposer.test.tsx
npx vitest run src/features/agent-chat/AgentChatPane.test.tsx
```

**Done when:** both files are green, and every file in the spec's "Regression
— must stay green, unmodified" list is unaffected:
`composerMention.test.ts`, `composerNodes.test.ts`, `ComposerChip.test.tsx`,
`ComposerControls.test.tsx`, `MessagesTimeline.test.tsx`, `eventReducer.test.ts`,
`timeline.test.ts`, `adapter.test.ts`.

---

## Review, fix, finalize

Review runs once, over the whole change — not per task, matching the spec's
own commit-granularity constraint (the pre-commit hook typechecks the whole
project).

**Review lenses (parallel):**
- Spec conformance — walk the spec's Design §1–§5 against the six tasks above;
  flag any gap.
- TDD honesty — for each task, do the tests actually constrain the behavior
  (would they fail if the implementation were wrong), or were they written to
  match whatever the implementation produced?
- The Enter-priority contract, now with three suggestion plugins instead of
  one (D5's declaration order: submit keymap first, then the three triggers
  in any order).
- `composerMention.test.ts` byte-for-byte unmodified, and still green.
- Regression risk in every file the spec marks "Untouched": every Go file,
  `AgentChatPane.tsx`, `ComposerControls.tsx`, `ModelPicker.tsx`,
  `ComposerChip.tsx`, `composerNodes.ts`, `MessagesTimeline.tsx`,
  `eventReducer.ts`, `timeline.ts`, `adapter.ts`, `useAgentChatSocket.ts`,
  `features/rich-editor/*`, the vendored `components/ai-elements/*`.

**Fix:** apply confirmed findings only.

**Finalize:**

```
npm run typecheck
npm test
```

`npm test` must show **exactly one** failure (the pre-existing monaco guard
test) — see "Known-good baseline" above. Any other failure is a real
regression and must be fixed before this lands.

**Commit:** one commit, over the whole change (composerSerialize.ts,
ComposerSuggestionMenu.tsx + test, composerMention.ts, composerSkillTrigger.ts
+ test, composerSlashTrigger.ts + test, ComposerPromptEditor.tsx + test,
ChatComposer.tsx + test, AgentChatPane.test.tsx) — per the spec's own
commit-granularity note, this cannot land file-by-file.

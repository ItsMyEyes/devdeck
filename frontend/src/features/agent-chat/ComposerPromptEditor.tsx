/**
 * Plan T5 — the prompt editor. Assembles the extension set and owns the
 * Enter/Shift+Enter keymap; every other piece (T1's serialization, T2's chip
 * view, T3's chip nodes, T4's `@` mention) is composed here, not redefined.
 *
 * Explicit extension list — `StarterKit` is not used (design spec §3). The
 * document is inline content only: `Document.extend({ content: 'inline*' })`
 * plus `Text`, directly holding text and chip atoms with no paragraph
 * wrapper, matching `composerSerialize.ts`'s doc shape exactly. No headings,
 * lists, marks, or code blocks are registered, so none can exist.
 *
 * No `hardBreak` node either: `composerSerialize.ts`'s `ComposerInlineNode`
 * union is only `text | chip`, so Shift+Enter cannot insert a third node
 * type — it inserts a literal `\n` character into a text node instead (the
 * `editorProps.attributes.class` below carries `whitespace-pre-wrap` so that
 * renders as a real line break). This is the one deliberate deviation from
 * Tiptap's own `HardBreak` extension, which would otherwise be the obvious
 * choice for "Shift+Enter" (see its own `Shift-Enter` keymap in
 * `@tiptap/extension-hard-break`) — that node has no serialization T1 (or
 * this component) understands.
 *
 * Tiptap's `@tiptap/extensions` `Placeholder` decorates the nearest empty
 * *textblock* ancestor of the cursor (`buildPlaceholderDecorations`'s
 * "resolved path": `resolved.depth > 0 ? resolved.node(1) : resolved.nodeAfter`).
 * With no paragraph wrapper, an empty doc has no node *after* the cursor to
 * decorate, so that extension never fires here — confirmed by reading its
 * source, not assumed. The placeholder below is a plain absolutely-positioned
 * span instead, driven by the already-controlled `value` prop, which also
 * keeps this file self-contained (no new global CSS, which nothing in this
 * task owns).
 *
 * ## Keymap priority — the design spec's highest-risk detail
 *
 * Tiptap builds its final ProseMirror plugin list by reversing the declared
 * `extensions` array and re-sorting by priority (`ExtensionManager.plugins`,
 * `@tiptap/core`): for extensions of equal priority (the default for every
 * extension used here), the array is effectively processed in REVERSE
 * declaration order, and each extension contributes its keymap plugin AND
 * its `addProseMirrorPlugins()` plugins together, in that reversed slot.
 * ProseMirror's keydown dispatch walks `state.plugins` in order and stops at
 * the first plugin that handles the event.
 *
 * The consequence: the LATER an extension is declared here, the EARLIER its
 * plugins are checked. `composerSubmitKeymap` is declared BEFORE
 * `createComposerMention(...)` below so that the mention's `Suggestion`
 * plugin (whose `render().onKeyDown` intercepts Enter while its menu is
 * open — see `composerMention.ts`) is checked first. When the menu is open,
 * `onKeyDown` returns `true` (select-and-stop) and the submit keymap's
 * `Enter` handler never runs; when it is closed, `Suggestion`'s handler
 * returns `false` and Enter falls through to submit. Both directions are
 * verified empirically (not just reasoned about) in
 * `ComposerPromptEditor.test.tsx`, including a spike that swapped the
 * declaration order and watched the "does not submit" assertion fail before
 * settling on this order.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import type { JSONContent } from '@tiptap/core'
import { Extension } from '@tiptap/core'
import { Document } from '@tiptap/extension-document'
import { Text } from '@tiptap/extension-text'
import { UndoRedo } from '@tiptap/extensions'
import { EditorContent, useEditor } from '@tiptap/react'

import { cn } from '@/lib/utils'
import type { Machine } from '@/store/types'
import { useAgentSkills } from '@/features/data/queries'

import { createComposerMention, worktreeMentionSource } from '@/features/agent-chat/composerMention'
import type { MentionSource } from '@/features/agent-chat/composerMention'
import { composerChipNodeName, composerChipNodeToChip, composerChipNodes } from '@/features/agent-chat/composerNodes'
import { composerText, parseComposerText, serializeComposerDoc } from '@/features/agent-chat/composerSerialize'
import type { ComposerChipKind, ComposerDoc, ComposerInlineNode } from '@/features/agent-chat/composerSerialize'
import { createComposerSkillTrigger } from '@/features/agent-chat/composerSkillTrigger'
import type { SkillCatalogSnapshot } from '@/features/agent-chat/composerSkillTrigger'
import { createComposerSlashTrigger } from '@/features/agent-chat/composerSlashTrigger'
import type { InteractionMode } from '@/features/agent-chat/useAgentChatSocket'

/**
 * Plan T14 — the escape hatch for callers that need to put a chip in the
 * document without going through `value` (a plain string can never encode a
 * chip — see `parseComposerText`'s own doc comment). The bridge that inserts
 * a captured terminal selection (`ExpandedTerminal.tsx`, T15) reaches the
 * focused pane's editor through this.
 */
export interface ComposerPromptEditorHandle {
  /** Inserts a chip node at the current cursor position. Goes through
   *  `editor.commands`, the same path plain typing does, so it fires
   *  `onUpdate` → `onChange` exactly like a keystroke would — keeping
   *  `lastValue.current` (below) and the parent's `value` in agreement, so
   *  the external-value effect's guard does not immediately undo the
   *  insert on the next render. */
  insertChip: (kind: ComposerChipKind, value: string, label?: string) => void
}

export interface ComposerPromptEditorProps {
  /** The editor's whole I/O surface is a plain string — same contract the
   *  textarea it replaces had, so the parent chain (`onSend`, and everything
   *  downstream of it) is unchanged. See the design spec's "Value contract". */
  value: string
  onChange: (value: string) => void
  /** Enter's outcome when it is not consumed by the mention/skill/command
   *  menu. Takes no argument — the caller already has the current text
   *  through `onChange`, the same way `ChatComposer`'s own `text` state
   *  already works today. */
  onSubmit: () => void
  placeholder?: string
  disabled?: boolean
  /** Threaded straight into the `@` mention trigger (T4) — see the design
   *  spec's §4 "Threading its two arguments is part of this work". Still
   *  required even when `mentionSource` is supplied: SSH threads pass
   *  `NO_MACHINE`/`''` the same way every worktree-less caller already does
   *  (`ChatComposer`'s `NO_MACHINE`), because nothing here reads them in
   *  that case. */
  machine: Machine
  worktreeId: string
  /** Plan T13 — overrides the `@` mention menu's data source. Absent for
   *  every worktree thread today: this component falls back to
   *  `worktreeMentionSource(machine, worktreeId)`, exactly what it called
   *  directly before this prop existed, so every existing caller (including
   *  `ChatComposer.test.tsx`'s `NO_MACHINE` mounts) is unaffected. An SSH
   *  thread's chat pane supplies `sshMentionSource(connectionId)` instead. */
  mentionSource?: MentionSource
  /** The effective agent for the next turn — drives the `$` skill catalog
   *  (D3/D5). The caller (`ChatComposer`, D6) derives this from the model
   *  picker, not the worktree's static default — see the design spec's §5. */
  agentId: string
  /** Wired to the `/` command trigger (D4) — `/plan` and `/build` each
   *  dispatch through this rather than inserting any text. */
  onInteractionModeChange: (mode: InteractionMode) => void
}

/** No paragraph wrapper: text and chip atoms sit directly in `doc.content`,
 *  mirroring `composerSerialize.ts`'s `ComposerDoc` shape one-for-one. */
const ComposerDocument = Document.extend({ content: 'inline*' })

interface ComposerKeymapSnapshot {
  onSubmit: () => void
  disabled: boolean
}

/**
 * Enter submits; Shift+Enter inserts a literal newline. Reads `onSubmit`/
 * `disabled` through a ref rather than closing over the props directly —
 * the extension list is only built once, when the editor is constructed
 * (see `useEditor`'s dependency array below), so a plain closure over props
 * would go stale across re-renders the way `NotionEditor.tsx` describes for
 * its own `onChange`/`onBlur` refs.
 */
function createComposerSubmitKeymap(snapshot: { current: ComposerKeymapSnapshot }) {
  return Extension.create({
    name: 'composerSubmitKeymap',

    addKeyboardShortcuts() {
      return {
        Enter: () => {
          if (snapshot.current.disabled) return false
          snapshot.current.onSubmit()
          return true
        },
        'Shift-Enter': () => {
          if (snapshot.current.disabled) return false
          return this.editor.commands.insertContent({ type: 'text', text: '\n' })
        },
      }
    },
  })
}

/** A node from `editor.getJSON().content` → T1's `ComposerInlineNode`. Chip
 *  nodes go through T3's `composerChipNodeToChip`; anything else in this
 *  schema is a text node (the only two node families registered below). */
function toComposerInlineNode(node: JSONContent): ComposerInlineNode {
  if (node.type === 'text') return composerText(node.text ?? '')
  return composerChipNodeToChip({ type: node.type ?? '', attrs: node.attrs })
}

function toComposerDoc(content: JSONContent[] | undefined): ComposerDoc {
  return { type: 'doc', content: (content ?? []).map(toComposerInlineNode) }
}

export const ComposerPromptEditor = forwardRef<ComposerPromptEditorHandle, ComposerPromptEditorProps>(
  function ComposerPromptEditor(
    {
      value,
      onChange,
      onSubmit,
      placeholder,
      disabled = false,
      machine,
      worktreeId,
      mentionSource,
      agentId,
      onInteractionModeChange,
    },
    ref,
  ) {
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const keymapSnapshot = useRef<ComposerKeymapSnapshot>({ onSubmit, disabled })
  keymapSnapshot.current = { onSubmit, disabled }

  // The `$` skill catalog — fetched here, closest to its only consumer (the
  // design spec's §5: "`useAgentSkills` is called in `ComposerPromptEditor`
  // ... and passed down as `skills`"). Read through a ref snapshot, not a
  // closure, for the same reason `keymapSnapshot` is: the extension list is
  // built once and only rebuilt on `[machine.id, worktreeId]` below, so a
  // closure over `skillsData` would freeze the catalog at its first
  // (loading, empty) value across re-renders — e.g. every model-picker
  // switch that changes the effective agent.
  const { data: skillsData, isLoading: skillsLoading, error: skillsError } = useAgentSkills(machine, agentId)
  const skillCatalog = useRef<SkillCatalogSnapshot>({ status: 'loading', skills: [], agentId })
  skillCatalog.current = {
    status: skillsError ? 'error' : skillsLoading ? 'loading' : 'ready',
    skills: skillsData ?? [],
    agentId,
  }

  const onInteractionModeChangeRef = useRef(onInteractionModeChange)
  onInteractionModeChangeRef.current = onInteractionModeChange

  // The value this component last emitted (or received), so an external
  // `value` update — the parent clearing the draft after send — can be told
  // apart from this component's own edit bouncing back through `value`.
  // Seeded with the initial value, not `null`, so the very first render
  // doesn't immediately re-set content it just created from that same value
  // (mirrors `NotionEditor.tsx`'s `lastMarkdown` seeding for the same reason).
  const initialValue = useRef(value)
  const lastValue = useRef(initialValue.current)

  const editor = useEditor(
    {
      extensions: [
        ComposerDocument,
        Text,
        ...composerChipNodes,
        UndoRedo,
        // Declared before the three suggestion triggers — see this file's
        // header comment on keymap priority. Order among the three triggers
        // themselves is irrelevant (design spec §5): `@tiptap/suggestion`'s
        // `handleKeyDown` only intercepts when its own plugin is active, and
        // their `char`s ('@', '$', '/') are mutually exclusive at any cursor.
        createComposerSubmitKeymap(keymapSnapshot),
        createComposerMention(mentionSource ?? worktreeMentionSource(machine, worktreeId)),
        createComposerSkillTrigger(skillCatalog),
        createComposerSlashTrigger(onInteractionModeChangeRef),
      ],
      content: parseComposerText(initialValue.current),
      editable: !disabled,
      editorProps: {
        attributes: {
          class: cn(
            'composer-prompt-editor min-h-6 min-w-0 whitespace-pre-wrap break-words text-sm leading-6 text-foreground outline-none',
          ),
          // A `contenteditable` div has no implicit role, so without these it
          // is not a text input to anything that isn't a sighted mouse user:
          // not to a screen reader, and not to `getByRole('textbox')`. The
          // textarea this replaced announced itself for free; TipTap does not,
          // and the multi-line hint has to be explicit because `textbox`
          // defaults to single-line.
          role: 'textbox',
          'aria-multiline': 'true',
          ...(placeholder ? { 'aria-label': placeholder } : {}),
        },
      },
      onUpdate({ editor: instance }) {
        const text = serializeComposerDoc(toComposerDoc(instance.getJSON().content))
        lastValue.current = text
        onChangeRef.current(text)
      },
    },
    // Rebuilt when the worktree context — or an explicit `mentionSource`
    // override (T13) — changes: `createComposerMention` bakes its source
    // into its closure at construction time (T4's contract), so there is no
    // live way to update it in place.
    [machine.id, worktreeId, mentionSource],
  )

  // No deps array: `editor` is freshly captured on every render (mirrors
  // `NotionEditor.tsx`'s `insertMarkdown`), so a stale closure never lingers
  // across the `[machine.id, worktreeId]` rebuild above.
  useImperativeHandle(ref, () => ({
    insertChip: (kind: ComposerChipKind, chipValue: string, label?: string) => {
      editor?.commands.insertContent({ type: composerChipNodeName(kind), attrs: { value: chipValue, label } })
    },
  }))

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])

  // Pushes an external `value` change into the editor — e.g. the parent
  // clearing the draft after a send. One-way in the other direction: a
  // plain string can never be told apart from typed text, so this never
  // reconstructs chips (see `parseComposerText`'s own doc comment).
  useEffect(() => {
    if (!editor) return
    if (lastValue.current === value) return
    lastValue.current = value
    editor.commands.setContent(parseComposerText(value), { emitUpdate: false })
  }, [editor, value])

  return (
    // `max-h`/`overflow-y-auto`: a long prompt scrolls inside the box instead
    // of growing it without bound. The editor is the composer's only
    // auto-height child, so before this a pasted essay pushed the transcript
    // (or, in the hero placement, the heading) off screen.
    <div className="relative max-h-[min(40vh,220px)] min-w-0 overflow-y-auto">
      {value.length === 0 && placeholder ? (
        // `inset-x-0` + `truncate`, NOT `left-0`: the placeholder is
        // absolutely positioned over a one-line-tall editor, so an unbounded
        // one wraps to a second line the editor has no height for and lands
        // on top of the control row below it — which is exactly what a 300px
        // SSH rail did to "Ask for changes, or describe what to build".
        // Clipping to one line makes that structurally impossible at any
        // width. `leading-6` matches the editor's own line box so the
        // placeholder sits exactly where the caret does.
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 truncate leading-6 select-none text-sm text-muted-foreground"
        >
          {placeholder}
        </span>
      ) : null}
      <EditorContent editor={editor} className="min-w-0" />
    </div>
  )
})

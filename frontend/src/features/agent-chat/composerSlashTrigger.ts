/**
 * Plan D4 — the `/` slash trigger. Turns on the "dormant" `/` mention the
 * design spec's §5 describes: typing `/` at the start of a line opens D2's
 * shared `ComposerSuggestionMenu` filtered against a static, in-module list
 * of built-in commands, and selecting one dispatches an interaction-mode
 * change through a callback — no node insertion, because a command is an
 * action on the composer, not a reference embedded in the prompt (spec §2:
 * "which is why G defined only three chip types").
 *
 * Deliberately just two commands (spec's own Non-goals: `/model` and
 * provider slash commands are out of scope): `/plan` and `/build` each map
 * onto `setInteractionMode`, a sink that already works today
 * (`ComposerControls.tsx:184` -> `useAgentChatSocket.ts:325`). `/build`, not
 * t3code's `/default`, because "Build" is this product's own word for
 * `InteractionMode.default`; `'default'` is kept as a matching keyword so
 * t3code muscle memory still lands.
 *
 * `/` is line-start, not word-start (spec §4) — `fix the /plan thing` and
 * `https://host/path` must not open a menu. `slashLineStartAllow` reads the
 * character before `range.from` directly rather than `@tiptap/suggestion`'s
 * own `startOfLine` option, which anchors `^` against
 * `$position.nodeBefore.text` and would misfire right after a chip atom.
 */
import { Hammer } from 'lucide-react'
import { Extension } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import { PluginKey } from '@tiptap/pm/state'
import { ReactRenderer } from '@tiptap/react'
import { Suggestion } from '@tiptap/suggestion'
import type { SuggestionProps } from '@tiptap/suggestion'
import type { RefAttributes } from 'react'

import type { InteractionMode } from '@/features/agent-chat/useAgentChatSocket'
import { ComposerSuggestionMenu } from '@/features/agent-chat/ComposerSuggestionMenu'
import type {
  ComposerSuggestionMenuHandle,
  ComposerSuggestionMenuItem,
  ComposerSuggestionMenuProps,
} from '@/features/agent-chat/ComposerSuggestionMenu'

const slashPluginKey = new PluginKey('composerSlashTrigger')

export interface BuiltInSlashCommand {
  id: string
  label: string
  description: string
  keywords?: string[]
  mode: InteractionMode
}

// Icon: Hammer for both — the glyph the (since removed) interaction-mode pill
// in ComposerControls.tsx used; these two rows are now the only way to switch
// Build/Plan from the composer, so the vocabulary lives on here.
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

/** Substring match over label, description and keywords — right-sized for a
 *  static 2-item list (spec §3), unlike `matchSkills`'s prefix/contains
 *  partitioning, which exists only because the skill catalog is 80+ deep. */
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
export function slashLineStartAllow({
  state,
  range,
}: {
  state: EditorState
  range: { from: number; to: number }
}): boolean {
  const { from } = range
  const charBefore = from > 0 ? state.doc.textBetween(from - 1, from, '\n', '\n') : ''
  return charBefore.length === 0 || charBefore === '\n'
}

/** What `ReactRenderer` infers for `ComposerSuggestionMenu`: the suggestion
 *  props it is handed (plus the popup's own `itemTestAttr`), and the ref the
 *  renderer attaches to reach `onKeyDown`. */
type SlashRenderer = ReactRenderer<
  ComposerSuggestionMenuHandle,
  ComposerSuggestionMenuProps<ComposerSuggestionMenuItem> & RefAttributes<ComposerSuggestionMenuHandle>
>

/**
 * Builds the `/` command extension. `onInteractionModeChangeRef` is a ref
 * (not a plain callback) for the same reason D3's `snapshot` is: the
 * extension list is built once and only rebuilt on `[machine.id,
 * worktreeId]` (D5, `ComposerPromptEditor.tsx`), so a closure over the
 * callback prop would freeze it at its first value across re-renders.
 */
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

/**
 * Plan D3 — the `$` skill trigger. Turns on the "dormant" `$` mention the
 * design spec's §5 describes: typing `$` opens D2's shared
 * `ComposerSuggestionMenu` filtered against the machine's skill catalog, and
 * selecting an entry inserts a `composerSkillChip` node (T3,
 * `composerNodes.ts`) — the node D1 already knows how to serialize to
 * `[$name](skill:name)`.
 *
 * Reuses D2's `mentionAllow` directly rather than redefining a word-start
 * rule a third time — `$` needs exactly the same "must start a word" guard
 * `@` does (design spec §3: `$` and `@` share the word-start rule, only `/`
 * is line-start).
 *
 * The skill catalog itself is not fetched here — `useAgentSkills` (D5, in
 * `ComposerPromptEditor`) owns the network request and loading/error state;
 * this file only ever reads whatever `snapshot.current` says right now.
 * `snapshot` is a ref-shaped object (`{ current: SkillCatalogSnapshot }`)
 * rather than a plain value because `Suggestion`'s `items()` closes over it
 * once at extension-creation time — a ref lets D5 keep the catalog live
 * across re-renders without recreating the extension (and the plugin) on
 * every fetch state change.
 */
import { Box } from 'lucide-react'
import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { ReactRenderer } from '@tiptap/react'
import { Suggestion } from '@tiptap/suggestion'
import type { SuggestionProps } from '@tiptap/suggestion'
import type { RefAttributes } from 'react'

import type { AgentSkill } from '@/store/types'
import { mentionAllow } from '@/features/agent-chat/composerMention'
import { composerChipNodeName } from '@/features/agent-chat/composerNodes'
import { ComposerSuggestionMenu } from '@/features/agent-chat/ComposerSuggestionMenu'
import type {
  ComposerSuggestionMenuHandle,
  ComposerSuggestionMenuItem,
  ComposerSuggestionMenuProps,
} from '@/features/agent-chat/ComposerSuggestionMenu'

const skillPluginKey = new PluginKey('composerSkillTrigger')

/** Keeps the popup a short list, matching D2's mention result cap. */
const SKILL_RESULT_LIMIT = 20

/** The machine's skill catalog, as D5's `useAgentSkills` sees it right now —
 *  `agentId` is threaded through so the error message can name which agent's
 *  catalog failed to load. */
export interface SkillCatalogSnapshot {
  status: 'loading' | 'ready' | 'error'
  skills: AgentSkill[]
  agentId: string
}

function byName(a: AgentSkill, b: AgentSkill): number {
  return a.name.localeCompare(b.name)
}

/**
 * Prefix hits before contains hits (matched on name or description), each
 * bucket sorted by name, capped at `SKILL_RESULT_LIMIT`. Deliberately not
 * t3code's `searchProviderSkills` scoring — this repo's `AgentSkill`
 * (`store/types.ts:381-386`) has no `shortDescription`/`scope`/
 * `displayName`/`enabled` to rank against.
 */
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

/** What `ReactRenderer` infers for `ComposerSuggestionMenu`: the suggestion
 *  props it is handed (plus the popup's own overrides), and the ref the
 *  renderer attaches to reach `onKeyDown`. */
type SkillRenderer = ReactRenderer<
  ComposerSuggestionMenuHandle,
  ComposerSuggestionMenuProps<ComposerSuggestionMenuItem> & RefAttributes<ComposerSuggestionMenuHandle>
>

/**
 * Builds the `$` skill extension. `snapshot` is read live on every
 * keystroke and every render — `items()` never calls the network itself, it
 * only filters whatever `snapshot.current.skills` already holds, and
 * `render()`'s `extend()` substitutes `snapshot.current.status` for
 * tiptap's own inferred `loading` prop (`items()` here always resolves
 * synchronously and never throws, so tiptap has nothing real to infer).
 */
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
          // Same '\n'-prefix fix D2 applied to `@` — a `$` typed at the start
          // of a Shift+Enter continuation line is preceded by a literal '\n'
          // text character, not a hardBreak node.
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

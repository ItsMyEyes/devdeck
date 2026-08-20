import type { RefAttributes } from 'react'
import { Extension } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import { ReactRenderer } from '@tiptap/react'
import { Suggestion, type SuggestionProps } from '@tiptap/suggestion'
import { matchBlockCommands, type BlockCommand } from './blocks'
import { SlashMenu, type SlashMenuHandle } from './SlashMenu'

const slashPluginKey = new PluginKey('devdeckSlashCommand')

/** What `ReactRenderer` infers for `SlashMenu`: the suggestion props it is
 *  handed, plus the ref the renderer attaches to reach `onKeyDown`. */
type SlashRenderer = ReactRenderer<
  SlashMenuHandle,
  SuggestionProps<BlockCommand, BlockCommand> & RefAttributes<SlashMenuHandle>
>

/**
 * Notion's "/" block menu. Trigger rules match the plain-markdown editor this
 * replaced — the "/" has to start a word, so a path like `src/foo` never opens
 * the menu — and `allow` keeps it out of code blocks, where a slash is just a
 * slash.
 */
export const SlashCommand = Extension.create({
  name: 'devdeckSlashCommand',

  addProseMirrorPlugins() {
    return [
      Suggestion<BlockCommand, BlockCommand>({
        editor: this.editor,
        pluginKey: slashPluginKey,
        char: '/',
        items: ({ query }) => matchBlockCommands(query),
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        command: ({ editor, range, props }) =>
          props.apply(editor.chain().focus().deleteRange(range)).run(),
        render: () => {
          let component: SlashRenderer | null = null
          let unmount: (() => void) | null = null

          return {
            onStart(props) {
              component = new ReactRenderer(SlashMenu, { props, editor: props.editor })
              // The plugin appends the element, anchors it to the caret, and
              // keeps it there through scroll/resize — no listeners of ours.
              unmount = props.mount(component.element as HTMLElement)
            },
            onUpdate(props) {
              component?.updateProps(props)
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

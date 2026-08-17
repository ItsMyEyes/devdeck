/**
 * Plan T4 — the `@` file/folder mention trigger. Mirrors
 * `features/rich-editor/slashCommand.ts` exactly: same `Suggestion` wiring,
 * same `ReactRenderer` lifecycle, same `props.mount` anchoring. Two stated
 * deviations from that file's shape:
 *
 * 1. `debounce` — `slashCommand.ts` matches over an in-memory list
 *    (`BLOCK_COMMANDS`) and needs no rate-limiting. This trigger calls the
 *    network on every keystroke (`searchWorktreeFiles`), so it uses
 *    `@tiptap/suggestion`'s own `debounce` option (design spec §4: "Results
 *    are debounced") instead of leaving it unset. `debounceMs` is a
 *    parameter (not a constant) purely so tests can pass `0` and avoid
 *    waiting on a real timer; production always gets the default.
 * 2. `command` builds the chip insertion itself, rather than delegating to a
 *    per-item `apply(chain)` the way `BlockCommand` does — a mention item is
 *    a plain search-result path, not a self-describing command object, so
 *    there is nothing for it to delegate to.
 *
 * Plan D2 — the popup itself no longer lives in this file. It moved to
 * `ComposerSuggestionMenu.tsx`, shared with D3's `$` skill trigger and D4's
 * `/` slash trigger rather than writing the same highlight/arrow-key/
 * Enter-Tab popup a third time (design spec §2: "Extraction, not a third
 * copy"). `isMentionWordStart` and `mentionAllow` — the pure word-start rule
 * and its `Suggestion.allow` wiring — are untouched in name and signature;
 * D3 imports `mentionAllow` directly.
 *
 * D2 also fixes the `\n`-prefix bug (design spec Problem §3):
 * `@tiptap/suggestion`'s `findSuggestionMatch` discards any match whose
 * preceding character isn't in `allowedPrefixes`, which defaults to `[' ']`
 * only (`node_modules/@tiptap/suggestion/dist/index.js:646`, verified by
 * reading the installed package). G's editor has no `hardBreak` node —
 * Shift+Enter inserts a literal `'\n'` text character
 * (`ComposerPromptEditor.tsx:118-121`) — so the character before a trigger
 * typed at the start of any continuation line is `'\n'`, and the match was
 * discarded before `mentionAllow` ever got a say. `allowedPrefixes: [' ',
 * '\n']` is the fix, and it is the only change to this extension's runtime
 * behavior in this file.
 */
import type { RefAttributes } from 'react'
import { Extension } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import { PluginKey } from '@tiptap/pm/state'
import { ReactRenderer } from '@tiptap/react'
import { Suggestion } from '@tiptap/suggestion'
import { File, Folder } from 'lucide-react'

import { searchWorktreeFiles } from '@/lib/machineApi'
import type { Machine } from '@/store/types'

import { composerChipNodeName } from './composerNodes'
import { ComposerSuggestionMenu } from './ComposerSuggestionMenu'
import type {
  ComposerSuggestionMenuHandle,
  ComposerSuggestionMenuItem,
  ComposerSuggestionMenuProps,
} from './ComposerSuggestionMenu'

const mentionPluginKey = new PluginKey('composerMention')

/** Production rate-limit on `items()` calls — see the header comment's
 *  deviation (1). */
const DEFAULT_MENTION_DEBOUNCE_MS = 200

/** Keeps the popup a short list rather than a second scrollable file tree. */
const MENTION_RESULT_LIMIT = 20

/** A `@` mention search hit — a worktree-relative path.
 *  `WorktreeFileService.Search` (`includeDirs: true`) returns directories
 *  trailing-slash-suffixed; that suffix is also how the icon below is
 *  chosen, so no separate `isDir` flag needs to cross the wire. */
export interface MentionFileItem {
  path: string
}

/**
 * Plan T13 — the `@` mention menu's data source, factored out of
 * `createComposerMention` so the same trigger/popup/insertion machinery
 * serves two very different backends: a worktree thread searches a
 * worktree's files through a runtime machine (`worktreeMentionSource`); an
 * SSH thread searches a remote host's filesystem through the hub
 * (`sshMentionSource`). Only the source changes — the menu, the debounce,
 * the result limit, and the insertion behaviour below are all shared.
 *
 * Design spec D7: a mention inserts the path and nothing else. Both
 * factories below hand back exactly the strings their backend returns —
 * worktree-relative for one, absolute for the other — and neither this
 * interface nor `createComposerMention` interprets, normalizes, or fetches
 * the contents behind them. An agent that needs the contents reads the path
 * itself, through a tool.
 */
export interface MentionSource {
  /** Resolves to up to `MENTION_RESULT_LIMIT`-and-then-some raw paths for
   *  `query` — the caller (this file's `items()`) does the trimming, so a
   *  source only has to answer the search. */
  search: (query: string) => Promise<string[]>
}

/**
 * Wraps today's worktree file search with no change in what it requests:
 * the same `searchWorktreeFiles(machine, worktreeId, query, {includeDirs:
 * true})` call `createComposerMention` used to make directly (see the
 * design spec's §4, "`machineRequest` is what makes the call work when the
 * worktree lives on a remote machine").
 */
export function worktreeMentionSource(machine: Machine, worktreeId: string): MentionSource {
  return {
    search: (query) => searchWorktreeFiles(machine, worktreeId, query, { includeDirs: true }),
  }
}

/** Mirrors `sshFileApi.ts`'s own local constant — that file's typed client
 *  (`searchSSHFiles`) goes through `lib/api.ts`'s `request()`, which this
 *  deliberately does not: `request()` also calls `res.text()`, which a
 *  fetch mock that only stubs `ok`/`json()` (this file's own test, and any
 *  future caller mocking the platform `fetch`) does not implement. A plain
 *  `fetch` + `res.json()` is the whole contract this needs. */
const SSH_MENTION_API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'

/**
 * Queries an SSH connection's remote filesystem search route
 * (`GET /api/ssh/connections/{id}/files/search?pattern=`, already
 * implemented — `main.go:754`) and hands back its paths verbatim. Those
 * paths are absolute remote paths, not worktree-relative ones, and design
 * spec D7 requires them inserted unchanged — so unlike
 * `worktreeMentionSource`, there is no shared typed client to reuse here:
 * `SSHRightSidebar`'s existing `searchSSHFiles` (`lib/sshFileApi.ts`) is
 * exactly this request, but going through it would mean going through
 * `request()` too, which this file's test deliberately avoids (see
 * `SSH_MENTION_API_BASE`'s comment).
 */
export function sshMentionSource(connectionId: string): MentionSource {
  return {
    search: async (query) => {
      const params = new URLSearchParams({ pattern: query })
      const res = await fetch(`${SSH_MENTION_API_BASE}/ssh/connections/${connectionId}/files/search?${params}`)
      return (await res.json()) as string[]
    },
  }
}

/**
 * The `@` trigger's word-start guard, factored out as a pure function so it
 * is unit-testable without a ProseMirror state at all (design spec's
 * Testing section files this under "Unit (no DOM)"). Mirrors
 * `slashCommand.ts`'s rule for `/` — "the '/' has to start a word, so a
 * path like `src/foo` never opens the menu" — translated to `@`: the
 * character immediately before the trigger must be whitespace or nothing
 * (start of line/doc), so `@` embedded in a pasted path (`src/foo@bar`) or
 * an email address (`a@b.com`) never opens the menu.
 */
export function isMentionWordStart(charBeforeTrigger: string): boolean {
  return charBeforeTrigger.length === 0 || /\s/.test(charBeforeTrigger)
}

/**
 * `Suggestion`'s `allow` callback, wired to the pure rule above. Exported
 * separately from `isMentionWordStart` so the wiring itself — reading the
 * one character before `range.from` out of a real `state.doc` — is also
 * directly testable, against a plain `EditorState` with no DOM involved.
 */
export function mentionAllow({ state, range }: { state: EditorState; range: { from: number; to: number } }): boolean {
  const { from } = range
  const charBefore = from > 0 ? state.doc.textBetween(from - 1, from, '\n', '\n') : ''
  return isMentionWordStart(charBefore)
}

function toMenuItem(path: string): ComposerSuggestionMenuItem {
  return { id: path, label: path, icon: path.endsWith('/') ? Folder : File }
}

/** What `ReactRenderer` infers for `ComposerSuggestionMenu`: the suggestion
 *  props it is handed (plus the popup's own `itemTestAttr`), and the ref the
 *  renderer attaches to reach `onKeyDown`. */
type MentionRenderer = ReactRenderer<
  ComposerSuggestionMenuHandle,
  ComposerSuggestionMenuProps<ComposerSuggestionMenuItem> & RefAttributes<ComposerSuggestionMenuHandle>
>

/**
 * Builds the `@` mention extension over a `MentionSource` (T13) —
 * `ComposerPromptEditor` (T5) decides which one: `worktreeMentionSource` for
 * a worktree thread, `sshMentionSource` for an SSH thread. This file no
 * longer knows or cares which; it only calls `source.search(query)`.
 *
 * `debounceMs` defaults to the production value; tests pass `0` to avoid
 * waiting on a real timer (see the header comment's deviation (1)).
 */
export function createComposerMention(source: MentionSource, debounceMs = DEFAULT_MENTION_DEBOUNCE_MS) {
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
            const results = await source.search(query)
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
                // The plugin appends the element, anchors it to the caret, and
                // keeps it there through scroll/resize — no listeners of ours.
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

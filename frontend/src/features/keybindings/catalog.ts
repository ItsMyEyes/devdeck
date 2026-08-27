import type { Chord } from '@/features/keybindings/chord'

/**
 * Every keyboard shortcut the app claims, in one place.
 *
 * Before this file each chord lived inline in the `window.addEventListener`
 * that owned it, which meant nothing could list them and nothing could rebind
 * them. Handlers now ask `matchesBinding(event, id)` instead of testing
 * `event.key` themselves, so this catalog is the single source of truth for
 * both the Settings › Keybindings table and the runtime behaviour.
 *
 * Adding a shortcut means adding a row here *and* calling `matchesBinding` at
 * the site — `keybindings.catalog.test.ts` guards the invariants this file
 * carries (unique ids, parseable defaults, no same-scope default collisions).
 */

/**
 * A binding's conflict domain, and the "Active in" hint shown in settings.
 *
 * Two commands collide only inside one scope. Chords intentionally repeat
 * *across* scopes — Cmd+T is a workspace tab outside a terminal and a shell tab
 * inside one; Cmd+S saves a file but stashes a prompt when the chat composer
 * holds focus — and flagging those would make the conflict column noise.
 */
export type KeybindingScope = 'workspace' | 'terminal' | 'editor' | 'explorer' | 'browser' | 'chat' | 'git'

/** Full sentences: this reads as the one-line subtitle under a section heading. */
export const SCOPE_LABEL: Record<KeybindingScope, string> = {
  workspace: 'Active anywhere in the workspace.',
  terminal: 'Active while a terminal or SSH pane has focus.',
  editor: 'Active while a file editor has focus.',
  explorer: 'Active while the file explorer tree has focus.',
  browser: 'Active while a browser tile has focus.',
  chat: 'Active while the agent chat composer has focus.',
  git: 'Active while the git panel commit box has focus.',
}

export interface KeybindingCommand {
  id: string
  label: string
  /** One line explaining what fires, and any context rule the handler applies. */
  description: string
  /** Display grouping in the settings table. */
  section: string
  scope: KeybindingScope
  /** Shipped chords. Multiple entries all fire the command. */
  defaults: Chord[]
  /**
   * xterm.js swallows Cmd/Ctrl chords before they reach `window`. Commands
   * flagged here are handed back to the app instead — see `isAppShortcut`.
   */
  escapesTerminal?: boolean
  /**
   * Match with or without Shift. Only for keys that sit on a shifted keycap,
   * where Cmd+= and Cmd++ are one keypress to the user.
   */
  looseShift?: boolean
}

export const KEYBINDING_COMMANDS: KeybindingCommand[] = [
  // ---- Workspace ---------------------------------------------------------
  {
    id: 'workspace.commandPalette',
    label: 'Open command palette',
    description: 'The one chord with no context rule — it opens from anywhere, including a focused terminal.',
    section: 'Workspace',
    scope: 'workspace',
    defaults: ['mod+k'],
    escapesTerminal: true,
  },
  {
    id: 'workspace.newTab',
    label: 'New workspace tab',
    description: 'Opens the tab chooser in the focused tile. Ignored inside a visible worktree terminal, which claims this chord for its own shell tabs.',
    section: 'Workspace',
    scope: 'workspace',
    defaults: ['mod+t'],
  },
  {
    id: 'workspace.newTabInTerminal',
    label: 'New workspace tab (inside a terminal)',
    description: 'The stand-in for the chord above while a worktree terminal is on screen.',
    section: 'Workspace',
    scope: 'workspace',
    defaults: ['mod+o'],
  },
  {
    id: 'workspace.closeTab',
    label: 'Close workspace tab',
    description: "Closes the focused tile's active tab. The Agents tab is pinned and never closes.",
    section: 'Workspace',
    scope: 'workspace',
    defaults: ['mod+w'],
  },
  {
    id: 'workspace.selectTab1',
    label: 'Go to tab 1',
    description: 'Selects the first tab in the focused tile — Agents.',
    section: 'Workspace',
    scope: 'workspace',
    defaults: ['mod+1'],
  },
  {
    id: 'workspace.selectTab2',
    label: 'Go to tab 2',
    description: 'Selects the second tab in the focused tile.',
    section: 'Workspace',
    scope: 'workspace',
    defaults: ['mod+2'],
  },
  {
    id: 'workspace.selectTab3',
    label: 'Go to tab 3',
    description: 'Selects the third tab in the focused tile.',
    section: 'Workspace',
    scope: 'workspace',
    defaults: ['mod+3'],
  },
  {
    id: 'workspace.selectTab4',
    label: 'Go to tab 4',
    description: 'Selects the fourth tab in the focused tile.',
    section: 'Workspace',
    scope: 'workspace',
    defaults: ['mod+4'],
  },
  {
    id: 'workspace.nextTab',
    label: 'Next tab',
    description: "Cycles the focused tile's tab strip forward. Cmd-only by default: Ctrl+] is Escape to every terminal.",
    section: 'Workspace',
    scope: 'workspace',
    defaults: ['meta+]'],
  },
  {
    id: 'workspace.prevTab',
    label: 'Previous tab',
    description: "Cycles the focused tile's tab strip backward. Cmd-only by default, for the same reason as Next tab.",
    section: 'Workspace',
    scope: 'workspace',
    defaults: ['meta+['],
  },

  // ---- Terminal & SSH ----------------------------------------------------
  {
    id: 'terminal.quickOpenFile',
    label: 'Quick open file',
    description: "Fuzzy-finds a file in the worktree and opens it in the focused pane.",
    section: 'Terminal & SSH',
    scope: 'terminal',
    defaults: ['mod+p'],
    escapesTerminal: true,
  },
  {
    id: 'terminal.searchInFiles',
    label: 'Search in files',
    description: 'Opens ripgrep content search across the worktree. Not bound in SSH panes.',
    section: 'Terminal & SSH',
    scope: 'terminal',
    defaults: ['mod+shift+f'],
  },
  {
    id: 'terminal.newPaneTab',
    label: 'New shell tab',
    description: 'Adds a terminal tab to the focused pane.',
    section: 'Terminal & SSH',
    scope: 'terminal',
    defaults: ['mod+t'],
  },
  {
    id: 'terminal.closePaneTab',
    label: 'Close pane tab',
    description: "Closes the focused pane's active tab, prompting first if a file in it has unsaved edits.",
    section: 'Terminal & SSH',
    scope: 'terminal',
    defaults: ['mod+w'],
  },
  {
    id: 'terminal.toggleGit',
    label: 'Toggle git panel',
    description: 'Shows or hides the git panel in the focused pane. Worktree terminals only.',
    section: 'Terminal & SSH',
    scope: 'terminal',
    defaults: ['mod+g'],
  },
  {
    id: 'terminal.toggleExplorer',
    label: 'Toggle file explorer',
    description: 'Shows or hides the file tree in the focused pane.',
    section: 'Terminal & SSH',
    scope: 'terminal',
    defaults: ['mod+e'],
  },
  {
    id: 'terminal.toggleSidebar',
    label: 'Toggle right sidebar',
    description: 'Collapses or restores the pane sidebar.',
    section: 'Terminal & SSH',
    scope: 'terminal',
    defaults: ['mod+b'],
  },
  {
    id: 'terminal.find',
    label: 'Find in terminal',
    description: "Opens xterm's search bar over the focused terminal, instead of the browser's own find bar.",
    section: 'Terminal & SSH',
    scope: 'terminal',
    defaults: ['mod+f'],
  },

  // ---- Editor ------------------------------------------------------------
  {
    id: 'editor.save',
    label: 'Save file',
    description: 'Writes the active file tab, an untitled buffer, or an open SKILL.md.',
    section: 'Editor',
    scope: 'editor',
    defaults: ['mod+s'],
  },

  // ---- File explorer -----------------------------------------------------
  {
    id: 'explorer.newFile',
    label: 'New file',
    description: 'Starts an inline new-file row in the selected folder.',
    section: 'File explorer',
    scope: 'explorer',
    defaults: ['mod+n'],
  },
  {
    id: 'explorer.deleteSelection',
    label: 'Delete selection',
    description: 'Asks to delete every selected file or folder. Ignored while a rename input has focus.',
    section: 'File explorer',
    scope: 'explorer',
    defaults: ['delete', 'backspace'],
  },

  // ---- Browser tile ------------------------------------------------------
  {
    id: 'browser.focusAddressBar',
    label: 'Focus address bar',
    description: 'Opens the address input and selects its contents — pressing it again re-selects, as in Chrome.',
    section: 'Browser',
    scope: 'browser',
    defaults: ['mod+l'],
  },
  {
    id: 'browser.find',
    label: 'Find on page',
    description: "Opens the tile's find bar over the rendered page.",
    section: 'Browser',
    scope: 'browser',
    defaults: ['mod+f'],
  },
  {
    id: 'browser.zoomIn',
    label: 'Zoom in',
    description: 'Steps the tile zoom up.',
    section: 'Browser',
    scope: 'browser',
    defaults: ['mod+='],
    looseShift: true,
  },
  {
    id: 'browser.zoomOut',
    label: 'Zoom out',
    description: 'Steps the tile zoom down.',
    section: 'Browser',
    scope: 'browser',
    defaults: ['mod+-'],
    looseShift: true,
  },
  {
    id: 'browser.zoomReset',
    label: 'Reset zoom',
    description: 'Returns the tile to 100%.',
    section: 'Browser',
    scope: 'browser',
    defaults: ['mod+0'],
  },

  // ---- Git ---------------------------------------------------------------
  {
    id: 'git.commit',
    label: 'Commit staged changes',
    description: 'Commits from the git panel message box. Inert with an empty message or nothing staged.',
    section: 'Git',
    scope: 'git',
    defaults: ['mod+enter'],
  },

  // ---- Agent chat --------------------------------------------------------
  {
    id: 'chat.stashPrompt',
    label: 'Stash prompt',
    description: 'Parks the composer text for later. On an empty composer it opens the stash list instead.',
    section: 'Agent chat',
    scope: 'chat',
    defaults: ['mod+s'],
  },
]

export const COMMANDS_BY_ID: ReadonlyMap<string, KeybindingCommand> = new Map(
  KEYBINDING_COMMANDS.map((command) => [command.id, command]),
)

/** Section order for the settings table — declaration order in the catalog. */
export const KEYBINDING_SECTIONS: string[] = [
  ...new Set(KEYBINDING_COMMANDS.map((command) => command.section)),
]

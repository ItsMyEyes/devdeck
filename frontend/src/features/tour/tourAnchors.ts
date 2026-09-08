// The tour's structural vocabulary: which chapters exist, and which elements
// they are allowed to point at.
//
// One typed union rather than bare `data-tour="…"` strings scattered through
// the JSX: a step in `tourSteps.ts` and the attribute on the element it
// highlights are then the same symbol, so renaming or deleting one is a
// compile error instead of a step that silently highlights nothing.
//
// Anchors are attached to *chrome that already exists* — no wrapper divs, no
// extra DOM. Most of them are conditional (the Tauri-only tab strip, the
// desktop settings gear, every anchor below the `overview` group), which is
// why the tour runs with `skipMissingElement` on; see `tourSteps.ts`.

/** The tours on offer. `overview` is the one that runs itself the first time
 *  the app is opened — the front-door walk across the navigation. The rest are
 *  the deep ones the "?" panel offers once you are actually standing on the
 *  screen they narrate: they explain what each control on that screen *does*,
 *  and deliberately do not re-explain the menu that got you there.
 *
 *  Which of them is offerable is a question about the DOM, not about the route
 *  — `isTourChapterAvailable` answers it (see `tourSteps.ts`), so a chapter
 *  lights up wherever its chrome genuinely is. That matters here: the chat
 *  chapter narrates the same `AgentChatPane` whether it is a worktree's own
 *  pane or the SSH rail's DevOps chat, and the workspace chapter narrates the
 *  same panes and file tree in a worktree shell and an SSH shell alike. */
export const TOUR_CHAPTERS = ['overview', 'workspace', 'chat', 'ssh'] as const

export type TourChapter = (typeof TOUR_CHAPTERS)[number]

/** A runtime list, with the type derived from it rather than the other way
 *  round, so `tourAnchors.guard.test.ts` can walk every anchor and assert the
 *  JSX still attaches it somewhere. A step pointing at an anchor no component
 *  renders is a spotlight on empty screen, and nothing else would catch it.
 *
 *  Grouped by the chapter that narrates it, in reading order — the grouping is
 *  a comment only; `tourSteps.ts` owns the real order. */
export const TOUR_ANCHORS = [
  // ── overview: the app-level navigation, narrated on first launch ──
  'workspace-switcher',
  'sidebar-toggle',
  'nav-rail',
  'desktop-settings',
  'agents-heading',
  'agents-search',
  'agents-view-toggle',
  'agents-refresh',
  'agents-new',
  'agents-management',
  'worktree-card',
  'help-fab',

  // ── workspace: inside an open agent — the shell sidebar and the panes ──
  'shell-sidebar-toggle',
  'shell-sidebar-tabs',
  'explorer-new-file',
  'explorer-new-folder',
  'explorer-refresh',
  'explorer-collapse',
  'explorer-more',
  'explorer-quick-open',
  'explorer-content-search',
  'pane-tabs',
  'pane-new-tab',
  'pane-split-right',
  'pane-split-down',
  'pane-more-actions',
  'pane-close',

  // ── chat: the agent conversation pane, control by control ──
  'chat-header',
  'chat-telegram',
  'chat-transcript',
  'chat-input',
  'chat-model',
  'chat-effort',
  'chat-permission',
  'chat-usage',
  'chat-more-controls',
  'chat-attach',
  'chat-send',

  // ── ssh: the host list, and the rail inside a connected host ──
  'ssh-heading',
  'ssh-search',
  'ssh-view-toggle',
  'ssh-new-host',
  'ssh-host-card',
  'ssh-host-connect',
  'ssh-host-edit',
  'ssh-host-delete',
  'ssh-host-key',
  'ssh-rail-chat',
  'ssh-rail-stats',
  'ssh-rail-forwards',
  'ssh-chat-history',
  'ssh-chat-new-session',
] as const

export type TourAnchor = (typeof TOUR_ANCHORS)[number]

/** Spread onto the element a tour step highlights: `<button {...tourAnchor('agents-new')}>`. */
export function tourAnchor(anchor: TourAnchor): { 'data-tour': TourAnchor } {
  return { 'data-tour': anchor }
}

/** The CSS selector driver.js resolves for an anchor. Where several elements
 *  carry the same anchor (every worktree card does), driver.js highlights the
 *  first one in document order, which is what we want. */
export function tourSelector(anchor: TourAnchor): string {
  return `[data-tour="${anchor}"]`
}

// The order of each guided tour, and the DOM-aware filtering that keeps it
// honest.
//
// Most anchors are conditional chrome: the sidebar toggle only renders on the
// Agents/SSH views, the desktop settings gear only inside Tauri on a loopback
// hub, and there is no agent card at all in an empty workspace. Below `md` the
// sidebar is an off-canvas drawer — its buttons are in the DOM but translated
// out of the viewport, so "does it exist" is not the same question as "can the
// reader see it". `buildTourSteps` therefore resolves and vets every anchor up
// front and simply leaves the unusable ones out, so the progress counter reads
// "3 of 9" over nine real steps rather than counting ones that will be skipped.
//
// That same vetting is what makes the deep chapters work at all. `workspace`,
// `chat` and `ssh` narrate screens that are not always open, and several of
// their steps point at controls that only exist in some layouts — the composer
// pills collapse into one "More controls" button in a narrow pane, an SSH shell
// has no Git tab, a host list has no rail. Rather than branching on route or
// breakpoint, each chapter declares every control it could ever narrate and the
// DOM decides which of them the reader is actually looking at.

import type { DriveStep, Alignment, Side } from 'driver.js'
import { tourSelector, type TourAnchor, type TourChapter } from './tourAnchors'
import { tourCopy, type TourStepId } from './tourCopy'
import type { TourLang } from './tourPrefs'

interface TourStepDef {
  id: TourStepId
  /** Omitted only by each chapter's opening step, which is centred and has no
   *  target. */
  anchor?: TourAnchor
  side?: Side
  align?: Alignment
}

/** `overview` — reading order: the opening card, down the left rail, across
 *  the Agents toolbar, into a single agent card, then back out to the two
 *  corners that hold settings and this tour's own button. */
const OVERVIEW_STEPS: readonly TourStepDef[] = [
  { id: 'welcome' },
  { id: 'workspace-switcher', anchor: 'workspace-switcher', side: 'right', align: 'start' },
  { id: 'sidebar-toggle', anchor: 'sidebar-toggle', side: 'right', align: 'start' },
  { id: 'nav-rail', anchor: 'nav-rail', side: 'right', align: 'start' },
  { id: 'agents-heading', anchor: 'agents-heading', side: 'bottom', align: 'start' },
  { id: 'agents-search', anchor: 'agents-search', side: 'bottom', align: 'start' },
  { id: 'agents-view-toggle', anchor: 'agents-view-toggle', side: 'bottom', align: 'end' },
  { id: 'agents-refresh', anchor: 'agents-refresh', side: 'bottom', align: 'end' },
  { id: 'agents-new', anchor: 'agents-new', side: 'bottom', align: 'end' },
  { id: 'agents-management', anchor: 'agents-management', side: 'bottom', align: 'end' },
  { id: 'worktree-card', anchor: 'worktree-card', side: 'right', align: 'start' },
  { id: 'desktop-settings', anchor: 'desktop-settings', side: 'right', align: 'end' },
  { id: 'help-fab', anchor: 'help-fab', side: 'left', align: 'end' },
]

/** `workspace` — left to right across the shell: the panel toggle, the panel's
 *  own switcher, down the file-tree toolbar to the two search rows at its
 *  foot, then up into the pane header's tab strip and its controls. */
const WORKSPACE_STEPS: readonly TourStepDef[] = [
  { id: 'workspace-intro' },
  { id: 'shell-sidebar-toggle', anchor: 'shell-sidebar-toggle', side: 'bottom', align: 'start' },
  { id: 'shell-sidebar-tabs', anchor: 'shell-sidebar-tabs', side: 'bottom', align: 'start' },
  { id: 'explorer-new-file', anchor: 'explorer-new-file', side: 'bottom', align: 'end' },
  { id: 'explorer-new-folder', anchor: 'explorer-new-folder', side: 'bottom', align: 'end' },
  { id: 'explorer-refresh', anchor: 'explorer-refresh', side: 'bottom', align: 'end' },
  { id: 'explorer-collapse', anchor: 'explorer-collapse', side: 'bottom', align: 'end' },
  { id: 'explorer-more', anchor: 'explorer-more', side: 'bottom', align: 'end' },
  { id: 'explorer-quick-open', anchor: 'explorer-quick-open', side: 'top', align: 'start' },
  { id: 'explorer-content-search', anchor: 'explorer-content-search', side: 'top', align: 'start' },
  { id: 'pane-tabs', anchor: 'pane-tabs', side: 'bottom', align: 'start' },
  { id: 'pane-new-tab', anchor: 'pane-new-tab', side: 'bottom', align: 'start' },
  { id: 'pane-split-right', anchor: 'pane-split-right', side: 'bottom', align: 'end' },
  { id: 'pane-split-down', anchor: 'pane-split-down', side: 'bottom', align: 'end' },
  { id: 'pane-more-actions', anchor: 'pane-more-actions', side: 'bottom', align: 'end' },
  { id: 'pane-close', anchor: 'pane-close', side: 'bottom', align: 'end' },
]

/** `chat` — top to bottom through the conversation: header, transcript, then
 *  the composer from the prompt box down its control row to Send. */
const CHAT_STEPS: readonly TourStepDef[] = [
  { id: 'chat-intro' },
  { id: 'chat-header', anchor: 'chat-header', side: 'bottom', align: 'start' },
  { id: 'chat-telegram', anchor: 'chat-telegram', side: 'bottom', align: 'end' },
  { id: 'chat-transcript', anchor: 'chat-transcript', side: 'top', align: 'center' },
  { id: 'chat-input', anchor: 'chat-input', side: 'top', align: 'start' },
  { id: 'chat-model', anchor: 'chat-model', side: 'top', align: 'start' },
  { id: 'chat-effort', anchor: 'chat-effort', side: 'top', align: 'start' },
  { id: 'chat-permission', anchor: 'chat-permission', side: 'top', align: 'start' },
  { id: 'chat-usage', anchor: 'chat-usage', side: 'top', align: 'start' },
  { id: 'chat-more-controls', anchor: 'chat-more-controls', side: 'top', align: 'start' },
  { id: 'chat-attach', anchor: 'chat-attach', side: 'top', align: 'end' },
  { id: 'chat-send', anchor: 'chat-send', side: 'top', align: 'end' },
]

/** `ssh` — the host list first, then the rail inside a connected session. The
 *  two never share a screen, so in practice this runs as one half or the
 *  other; declaring both in one chapter is what lets the "?" panel offer a
 *  single "SSH" tour from either place. */
const SSH_STEPS: readonly TourStepDef[] = [
  { id: 'ssh-intro' },
  { id: 'ssh-heading', anchor: 'ssh-heading', side: 'bottom', align: 'start' },
  { id: 'ssh-search', anchor: 'ssh-search', side: 'bottom', align: 'start' },
  { id: 'ssh-view-toggle', anchor: 'ssh-view-toggle', side: 'bottom', align: 'end' },
  { id: 'ssh-new-host', anchor: 'ssh-new-host', side: 'bottom', align: 'end' },
  { id: 'ssh-host-card', anchor: 'ssh-host-card', side: 'right', align: 'start' },
  { id: 'ssh-host-key', anchor: 'ssh-host-key', side: 'bottom', align: 'start' },
  { id: 'ssh-host-connect', anchor: 'ssh-host-connect', side: 'top', align: 'start' },
  { id: 'ssh-host-edit', anchor: 'ssh-host-edit', side: 'top', align: 'start' },
  { id: 'ssh-host-delete', anchor: 'ssh-host-delete', side: 'left', align: 'start' },
  { id: 'ssh-rail-chat', anchor: 'ssh-rail-chat', side: 'left', align: 'start' },
  { id: 'ssh-chat-history', anchor: 'ssh-chat-history', side: 'bottom', align: 'end' },
  { id: 'ssh-chat-new-session', anchor: 'ssh-chat-new-session', side: 'bottom', align: 'end' },
  { id: 'ssh-rail-stats', anchor: 'ssh-rail-stats', side: 'left', align: 'start' },
  { id: 'ssh-rail-forwards', anchor: 'ssh-rail-forwards', side: 'left', align: 'start' },
]

const CHAPTER_STEPS: Record<TourChapter, readonly TourStepDef[]> = {
  overview: OVERVIEW_STEPS,
  workspace: WORKSPACE_STEPS,
  chat: CHAT_STEPS,
  ssh: SSH_STEPS,
}

interface Viewport {
  innerWidth: number
  innerHeight: number
}

/**
 * Whether an anchor is worth highlighting: laid out at all, and not parked
 * outside the viewport the way the mobile sidebar drawer parks itself
 * (`-translate-x-full`). A zero-size or off-canvas target would put the
 * spotlight on empty screen.
 */
export function isTourTargetVisible(element: Element, view: Viewport): boolean {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  return rect.right > 0 && rect.bottom > 0 && rect.left < view.innerWidth && rect.top < view.innerHeight
}

function resolveAnchor(anchor: TourAnchor, root: Document, view: Viewport): Element | null {
  const found = root.querySelector(tourSelector(anchor))
  return found && isTourTargetVisible(found, view) ? found : null
}

/**
 * Resolves one chapter against the DOM as it stands right now.
 *
 * Called on every start rather than memoised: the same operator can run it on
 * the desktop app and on a phone, on a full pane and in a 300px rail, and the
 * answer differs.
 */
export function buildTourSteps(
  chapter: TourChapter,
  lang: TourLang,
  root: Document = document,
  view: Viewport = window,
): DriveStep[] {
  const copy = tourCopy(lang)
  const steps: DriveStep[] = []

  for (const def of CHAPTER_STEPS[chapter]) {
    let element: Element | undefined
    if (def.anchor) {
      const found = resolveAnchor(def.anchor, root, view)
      if (!found) continue
      element = found
    }
    const text = copy.steps[def.id]
    steps.push({
      element,
      popover: {
        title: text.title,
        description: text.description,
        side: def.side,
        align: def.align,
      },
    })
  }

  return steps
}

/**
 * Whether a chapter has anything to say on the screen as it stands.
 *
 * The "?" panel lists every chapter and greys out the ones whose screen is not
 * open, rather than hiding them — a reader who cannot see the SSH tour has
 * learned something useful about where it lives. "Has something to say" means
 * at least one *anchored* step resolves: a chapter reduced to its own centred
 * intro card is a tour of nothing.
 */
export function isTourChapterAvailable(chapter: TourChapter, root: Document = document, view: Viewport = window): boolean {
  return CHAPTER_STEPS[chapter].some((def) => def.anchor !== undefined && resolveAnchor(def.anchor, root, view) !== null)
}

/**
 * What the "?" panel offers, in declared order.
 *
 * `overview` is always offered, regardless of what resolves. It is the
 * front-door tour of the app shell, and `HelpFab` only mounts on workspace
 * routes — where that shell is present by definition. Letting it grey itself
 * out on some narrow layout would take away the one tour that is always worth
 * running, over a technicality about which of its twelve anchors happened to
 * be laid out.
 */
export function availableTourChapters(root: Document = document, view: Viewport = window): Record<TourChapter, boolean> {
  return {
    overview: true,
    workspace: isTourChapterAvailable('workspace', root, view),
    chat: isTourChapterAvailable('chat', root, view),
    ssh: isTourChapterAvailable('ssh', root, view),
  }
}

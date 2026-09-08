import { useState } from 'react'

/**
 * Which of a tab strip's tabs currently have a body in the DOM.
 *
 * ── Why a tab is not built until you look at it ──
 *
 * Both tab strips in this app (the workspace tile strip in
 * `WorkspaceTileCanvas`, and the in-worktree pane strip in `PaneCanvas`) used
 * to render EVERY tab's content and merely `display:none` the inactive ones.
 * That is free for cheap content and ruinous for what actually lives in these
 * tabs: one agent-chat transcript mounts ~80 Streamdown entries (~9,000 DOM
 * nodes, ~125ms of markdown parsing, measured in Chromium on an M-series Mac),
 * and one terminal builds an xterm plus its own WebGL context.
 *
 * The cost only showed up on a workspace switch, because that is the one
 * action that rebuilds the whole set at once: the destination workspace's
 * layout replaces the source's, so React unmounts every open tab's body and
 * mounts every open tab's body of the new workspace inside a single
 * synchronous commit. Four open agent tabs measured ~490ms of blocked main
 * thread on the mount side alone — a visible freeze that got worse with every
 * extra project left open. Teardown is not the problem (~16ms for the same
 * four); mounting is.
 *
 * So a tab's body is built when it first becomes active, and then KEPT — the
 * cost is paid once, by the person who actually opened that tab, instead of
 * on every workspace switch for tabs nobody is looking at. Switching between
 * tabs you already use stays the instant `display:none` toggle it always was.
 *
 * What this deliberately does NOT do is unmount a tab when it goes
 * background: a mounted agent chat's socket and a mounted terminal's PTY
 * attachment are live state the operator expects to keep running while they
 * glance at something else. `Set` only ever grows, per strip.
 *
 * Nothing is lost by not mounting a tab: a terminal's PTY and an agent's
 * engine both live server-side and outlive the socket (see `Terminal.tsx` and
 * `useAgentChatSocket.ts`), so a tab that has never been opened reattaches and
 * replays on first activation exactly as it does after a reload.
 *
 * @param stripId  The leaf/pane this strip belongs to. When it changes, the
 *                 set resets — React reuses one `TileLeafView`/`LeafPaneView`
 *                 instance across a workspace switch (same component, same
 *                 position in the tree), so without re-anchoring, tab ids from
 *                 the workspace you just left would linger in the set.
 * @param activeTabId  The strip's selected tab. Always mounted.
 */
export function useMountedTabIds(stripId: string, activeTabId: string): ReadonlySet<string> {
  const [strip, setStrip] = useState(stripId)
  const [mounted, setMounted] = useState<ReadonlySet<string>>(() => new Set([activeTabId]))

  // Adjusted during render rather than in an effect, so the first paint of a
  // newly-selected tab already contains it — an effect would commit one frame
  // of an empty pane first. Same "derive state from props during render"
  // pattern as `MessagesTimeline`'s transcript window. The freshly computed
  // set is returned directly instead of the stale `mounted`, so the result is
  // correct even in the render pass that schedules the update.
  if (strip !== stripId) {
    const next: ReadonlySet<string> = new Set([activeTabId])
    setStrip(stripId)
    setMounted(next)
    return next
  }
  if (!mounted.has(activeTabId)) {
    const next: ReadonlySet<string> = new Set(mounted).add(activeTabId)
    setMounted(next)
    return next
  }
  return mounted
}

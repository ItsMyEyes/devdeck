/**
 * Thread title + status only. t3code's `ChatHeader.tsx` carries no model or
 * mode pickers at all — those moved into the composer footer as
 * `ComposerControl` pills (see `ComposerControl.tsx`, wired for real in
 * Task 7's `ComposerControls.tsx`). The four `Select`s this header used to
 * render at `min-w-[120px]`–`min-w-[150px]` inside a `flex-wrap` row are
 * gone, not restyled — that's the fix (design spec: "MOVE the controls, not
 * restyle them where they sit"). This alone removes ~430px of chrome that
 * used to wrap above an empty transcript.
 *
 * `machine` stays part of `ChatHeaderProps` even though this component no
 * longer reads it: `AgentChatPane.tsx` isn't in Task 6's file list and
 * still passes it down, and dropping it from the type would require
 * touching that file. See Task 6's `deviationsFromPlan`.
 *
 * SSH DevOps chat wrinkle (plan Task 12): `AgentChatPane` passes
 * `worktreeId={worktreeId ?? ''}` for every thread, and an SSH thread
 * (design spec `2026-08-17-ssh-devops-chat-design.md` §3.3/§7) truly has
 * none. `extraThreadSuffix('', threadKey)` would then slice the *entire*
 * `ssh:<connectionId>` thread key into the badge — not a suffix, the whole
 * id. `worktreeId === ''` is treated as "no worktree at all" rather than
 * "an empty-string worktree id" (no real worktree ever has one), and
 * `subjectLabel` — the connection's own name, the honest thing to show for
 * a server-scoped chat — takes the badge slot instead.
 */
import { MessageSquare } from 'lucide-react'
import { StatusDot } from '@/components/ui/status-dot'
import type { Machine } from '@/store/types'
import type { AgentThreadView } from '@/features/agent-chat/types'
import type { AgentSocketStatus } from '@/features/agent-chat/useAgentChatSocket'

const THREAD_STATUS_LABEL: Record<AgentThreadView['status'], string> = {
  idle: 'Idle',
  running: 'Running',
  waiting: 'Waiting',
  stopped: 'Stopped',
}

const SOCKET_DOT_COLOR: Record<AgentSocketStatus, string> = {
  // Idle/dim token, not the connecting amber — nothing is pending for a
  // thread that doesn't exist on the server yet (spec §4).
  draft: 'var(--devdeck-fg-2)',
  connecting: 'var(--devdeck-wait)',
  open: 'var(--devdeck-run)',
  closed: 'var(--devdeck-err)',
}

/** A `threadKey` beyond the bare worktree id names an extra chat pane split
 *  off the primary one (`paneTree.ts`'s `createAgentChatPane`) — surfaced
 *  as a small suffix badge so a second/third thread on the same worktree is
 *  visually distinguishable from the primary one. */
function extraThreadSuffix(worktreeId: string, threadKey: string): string | null {
  if (threadKey === worktreeId) return null
  const suffix = threadKey.slice(worktreeId.length)
  return suffix.startsWith('::') ? suffix.slice(2) : suffix
}

export interface ChatHeaderProps {
  machine: Machine
  worktreeId: string
  threadKey: string
  socketStatus: AgentSocketStatus
  threadStatus: AgentThreadView['status']
  /** Shown in the badge slot in place of the worktree-derived suffix for a
   *  thread with no worktree at all (`worktreeId === ''`) — an SSH thread,
   *  design spec §3.3. `undefined` renders no badge rather than a false one.
   *  Every worktree call site leaves this unset, so `worktreeId` being
   *  non-empty there keeps today's `extraThreadSuffix` path byte-for-byte. */
  subjectLabel?: string
}

export function ChatHeader({ worktreeId, threadKey, socketStatus, threadStatus, subjectLabel }: ChatHeaderProps) {
  const threadSuffix = worktreeId ? extraThreadSuffix(worktreeId, threadKey) : (subjectLabel ?? null)

  return (
    <div className="flex min-w-0 flex-none items-center gap-2 border-b border-devdeck-hairline bg-devdeck-pane px-4 py-2.5">
      <MessageSquare size={14} className="flex-none text-devdeck-fg-2" />
      <span className="truncate text-[13px] font-medium text-devdeck-fg">Chat</span>
      {threadSuffix ? (
        <span className="flex-none rounded-full bg-devdeck-raised px-2 py-0.5 text-[11px] text-devdeck-fg-2">{threadSuffix}</span>
      ) : null}
      <span className="ml-auto flex flex-none items-center gap-1.5 text-[12px] text-devdeck-fg-2">
        <StatusDot color={SOCKET_DOT_COLOR[socketStatus]} size={7} />
        {THREAD_STATUS_LABEL[threadStatus]}
      </span>
    </div>
  )
}

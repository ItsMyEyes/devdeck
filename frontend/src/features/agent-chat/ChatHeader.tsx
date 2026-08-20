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
 * `machine` was, for a while, part of `ChatHeaderProps` without this
 * component reading it (`AgentChatPane.tsx` passed it down regardless — see
 * Task 6's `deviationsFromPlan`). Telegram remote chat's Task 7
 * (docs/superpowers/plans/2026-08-18-telegram-remote-chat.md) puts it back
 * to use: `TelegramPublishButton` needs it to address this thread's
 * publish/unpublish calls at the right machine.
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
import type { ReactNode } from 'react'
import { MessageSquare } from 'lucide-react'
import { StatusDot } from '@/components/ui/status-dot'
import type { Machine } from '@/store/types'
import type { AgentThreadView } from '@/features/agent-chat/types'
import type { AgentSocketStatus } from '@/features/agent-chat/useAgentChatSocket'
import { TelegramPublishButton } from '@/features/agent-chat/TelegramPublishButton'

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
  // Same error colour as `closed` — both mean "not connected". The two differ
  // only in what the composer banner says about it (a socket that has never
  // opened stops claiming it is merely reconnecting), and a dot has no room to
  // carry that distinction.
  unreachable: 'var(--devdeck-err)',
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
  /** Thread-scoped icon buttons, rendered between the subject badge and the
   *  status readout. Whoever owns the thread's identity owns these: the SSH
   *  rail puts its session history + new-session pair here
   *  (`SSHAgentChatPanel`), because only it knows this connection's session
   *  key space and holds the setter that switches between them. Left unset by
   *  every worktree call site, which renders nothing extra. */
  actions?: ReactNode
}

/** Shared chrome for whatever a caller drops into `actions` — one size and
 *  one hover treatment, so a header button never has to be styled at each
 *  call site (and can never drift from the rail buttons it sits beside). */
export const chatHeaderActionClassName = [
  'flex size-6 flex-none cursor-pointer items-center justify-center rounded-md',
  'text-devdeck-fg-2 transition-colors hover:bg-devdeck-hover-wash hover:text-devdeck-fg',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
].join(' ')

export function ChatHeader({ machine, worktreeId, threadKey, socketStatus, threadStatus, subjectLabel, actions }: ChatHeaderProps) {
  const threadSuffix = worktreeId ? extraThreadSuffix(worktreeId, threadKey) : (subjectLabel ?? null)

  return (
    // `@container/chat-header`, and every element below sized off it: this
    // same header renders across a full pane and across a 300px SSH rail, and
    // at rail width the fixed row (icon + "Chat" + a connection-name badge +
    // buttons + "Idle") ran past the edge. Nothing is dropped — the badge
    // truncates and the status word folds down to its dot, both reversibly.
    <div className="@container/chat-header flex min-w-0 flex-none items-center gap-2 border-b border-devdeck-hairline bg-devdeck-pane px-2.5 py-2 @sm/chat-header:px-4 @sm/chat-header:py-2.5">
      <MessageSquare size={14} className="flex-none text-devdeck-fg-2" />
      <span className="flex-none text-[13px] font-medium text-devdeck-fg">Chat</span>
      {threadSuffix ? (
        // A subject worth reading, or nothing. This is the row's only
        // shrinkable item, so it absorbed every pixel the others took: beside
        // a `flex-none` publish button carrying ~140px of label it was handed
        // one character, "S". With that button reduced to an icon it sizes to
        // its content and truncates only when the row genuinely runs out —
        // no max-width, because a flex item does not grow on its own and a cap
        // would only clip a name that fits. The floor keeps a truncated one
        // legible rather than letting it collapse to a letter again.
        <span
          title={threadSuffix}
          className="min-w-[3.5rem] truncate rounded-full bg-devdeck-raised px-2 py-0.5 text-[11px] text-devdeck-fg-2"
        >
          {threadSuffix}
        </span>
      ) : null}
      {/* Space, not a divider, separates the two clusters — DESIGN.md's
          "boundaries are made of tone and space; a line is the last resort". */}
      <div className="ml-auto flex flex-none items-center gap-0.5 pl-1">
        <TelegramPublishButton machine={machine} threadId={threadKey} />
        {actions}
        {/* The dot already carries the state; the word is the redundant half,
            so it is the half that yields when the row runs out of room. The
            `title` sits on the wrapper, not on the word, so it is still
            reachable by hovering the dot in exactly the case where the word
            is not rendered. `@3xs` is 16rem — below that is the SSH rail at
            its 240px minimum, which is the width that needs this. */}
        <span
          title={THREAD_STATUS_LABEL[threadStatus]}
          className="ml-1.5 flex flex-none items-center gap-1.5 text-[12px] text-devdeck-fg-2"
        >
          <StatusDot color={SOCKET_DOT_COLOR[socketStatus]} size={7} />
          <span className="hidden @3xs/chat-header:inline">{THREAD_STATUS_LABEL[threadStatus]}</span>
        </span>
      </div>
    </div>
  )
}

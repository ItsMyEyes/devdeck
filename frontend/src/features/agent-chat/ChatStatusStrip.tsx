/**
 * Worktree / branch footer beneath the composer — t3code's status strip in
 * shape, DevDeck tokens in colour. Purely presentational: the caller
 * resolves which worktree and branch the open thread belongs to.
 *
 * Deviation from the plan: `AgentChatPane.tsx` isn't in Task 6's file list,
 * so it isn't wired to pass real worktree/branch data yet — `ChatComposer`
 * renders this with whatever it's given, falling back to a placeholder,
 * until a later task threads real data through. See `ChatComposer.tsx`'s
 * doc comment and this task's `deviationsFromPlan`.
 */
import { FolderGit2, GitBranch } from 'lucide-react'

export interface ChatStatusStripProps {
  worktree: string
  branch?: string | null
}

export function ChatStatusStrip({ worktree, branch }: ChatStatusStripProps) {
  return (
    <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-none items-center justify-between gap-2 px-5 pb-2 text-[11.5px] text-devdeck-dim-pane">
      <span className="flex min-w-0 items-center gap-1.5 truncate">
        <FolderGit2 size={11} className="flex-none" aria-hidden="true" />
        <span className="truncate">{worktree}</span>
      </span>
      <span className="flex flex-none items-center gap-1.5">
        <GitBranch size={11} aria-hidden="true" />
        {branch || '—'}
      </span>
    </div>
  )
}

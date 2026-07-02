import { GitBranch } from 'lucide-react'
import { EmptyState } from './EmptyState'

/** Shown when a project has no worktrees yet. */
export function ProjectEmpty({ onSpawn }: { onSpawn: () => void }) {
  return (
    <EmptyState
      icon={<GitBranch size={26} strokeWidth={1.5} />}
      title="No worktrees in this project yet"
      hint="Spawn an agent to create a worktree."
      action={{ label: '+ Spawn agent', onClick: onSpawn }}
    />
  )
}

import type { Project, Worktree } from '@/store/types'

/** A root-mode worktree has no branch to distinguish it from any other root
 *  session in the same project — a project can have several (each "+ Spawn
 *  shell" click adds one), so they're numbered by creation order ("root -
 *  shell 1", "root - shell 2", ...) instead of every one showing the same
 *  bare "project root". Branch-mode worktrees are unambiguous already and
 *  keep their plain branch name. */
export function worktreeLabel(project: Project | undefined, worktree: Worktree): string {
  if (!worktree.root) return worktree.branch
  const rootIndex = (project?.worktrees ?? []).filter((w) => w.root).findIndex((w) => w.id === worktree.id)
  return `root - shell ${rootIndex === -1 ? 1 : rootIndex + 1}`
}

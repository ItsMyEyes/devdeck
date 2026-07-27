import type { Project, Worktree } from '@/store/types'

/** 1-based creation order of a root shell among its project's root shells. */
function rootShellIndex(project: Project | undefined, worktree: Worktree): number {
  const index = (project?.worktrees ?? []).filter((w) => w.root).findIndex((w) => w.id === worktree.id)
  return index === -1 ? 1 : index + 1
}

/** A root-mode worktree has no branch to distinguish it from any other root
 *  session in the same project — a project can have several (each "+ Spawn
 *  shell" click adds one), so they're numbered by creation order ("root -
 *  shell 1", "root - shell 2", ...) instead of every one showing the same
 *  bare "project root". Branch-mode worktrees are unambiguous already and
 *  keep their plain branch name. */
export function worktreeLabel(project: Project | undefined, worktree: Worktree): string {
  if (!worktree.root) return worktree.branch
  return `root - shell ${rootShellIndex(project, worktree)}`
}

export interface WorktreeTabLabel {
  /** "devdeck/kali" — where the session lives (project + runtime machine).
   *  Shared by every tab of that project, so the tab strip renders it dim and
   *  truncates it first. */
  prefix: string
  /** "shell 3" / "feat/auth" — what actually tells this tab apart from its
   *  siblings. Rendered bright, truncated last. */
  name: string
  /** Full untruncated label, for tooltips and the "Workspace (A + B)" summary. */
  title: string
}

/** Tab-strip label for a worktree, split into a dim origin prefix and the
 *  bright per-session name. Unlike `worktreeLabel` the root marker moves out
 *  of `name` (the prefix already says which project's root it is) and into
 *  `title`, so a pinned strip of root shells reads "shell 1 / shell 2 / ..."
 *  instead of repeating "root - " in every pill. `machineName` is the runtime
 *  the project runs on — pass "local" for unassigned projects. */
export function worktreeTabLabel(
  project: Project | undefined,
  worktree: Worktree,
  machineName: string,
): WorktreeTabLabel {
  const name = worktree.root ? `shell ${rootShellIndex(project, worktree)}` : worktree.branch
  const prefix = project ? `${project.name}/${machineName}` : machineName
  return { prefix, name, title: `${prefix} · ${name}${worktree.root ? ' (root)' : ''}` }
}

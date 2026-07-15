import type { Machine } from '@/store/types'

/**
 * Where TerminalExplorer's (and SSHFileEditor's) file operations are backed
 * — a worktree checkout on a runtime machine, or a saved SSH connection's
 * remote filesystem over SFTP. Lets both UIs stay source-agnostic instead
 * of either data source needing to know about the other.
 */
export type FilesTarget = { kind: 'worktree'; machine: Machine; worktreeId: string } | { kind: 'ssh'; connectionId: string }

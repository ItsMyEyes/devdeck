// Typed client for runtime-machine-scoped resources: worktrees, worktree
// files, worktree git, project branches, and filesystem browsing. Every
// function takes the target Machine and resolves direct-vs-proxy through
// machineClient.ts. Hub-scoped resources (workspaces, todos, invoices, ...)
// stay in api.ts.

import type { FsEntry, Machine, TermLine, Worktree } from '@/store/types'
import { machineRequest } from './machineClient'

// ---- Worktrees ----

export interface CreateWorktreeBody {
  mode: 'branch' | 'root'
  branch?: string
  base?: string
  model: string
  agent: string
  task?: string
}

export interface UpdateWorktreeBody {
  branch?: string
  base?: string
  model?: string
  task?: string
  state?: Worktree['state']
  pending?: string | null
  ahead?: number
  behind?: number
  tokens?: number
  elapsed?: number
  added?: number
  removed?: number
  files?: number
  appendLine?: TermLine
}

export function createWorktree(machine: Machine, projectId: string, body: CreateWorktreeBody): Promise<Worktree> {
  return machineRequest<Worktree>(machine, 'POST', `/projects/${projectId}/worktrees`, body)
}

export function updateWorktree(machine: Machine, id: string, patch: UpdateWorktreeBody): Promise<Worktree> {
  return machineRequest<Worktree>(machine, 'PATCH', `/worktrees/${id}`, patch)
}

export function deleteWorktree(machine: Machine, id: string): Promise<void> {
  return machineRequest<void>(machine, 'DELETE', `/worktrees/${id}`)
}

// ---- Worktree files ----

export interface WorktreeFileEntry {
  name: string
  path: string
  isDir: boolean
  size: number
}

export interface WorktreeFileContent {
  path: string
  content: string
}

export function fetchWorktreeFiles(machine: Machine, worktreeId: string, path = ''): Promise<WorktreeFileEntry[]> {
  return machineRequest<WorktreeFileEntry[]>(
    machine,
    'GET',
    `/worktrees/${worktreeId}/files?path=${encodeURIComponent(path)}`,
  )
}

export function fetchWorktreeFile(machine: Machine, worktreeId: string, path: string): Promise<WorktreeFileContent> {
  return machineRequest<WorktreeFileContent>(
    machine,
    'GET',
    `/worktrees/${worktreeId}/file?path=${encodeURIComponent(path)}`,
  )
}

export function writeWorktreeFile(
  machine: Machine,
  worktreeId: string,
  body: WorktreeFileContent,
): Promise<WorktreeFileContent> {
  return machineRequest<WorktreeFileContent>(machine, 'PUT', `/worktrees/${worktreeId}/file`, body)
}

export function deleteWorktreeFile(machine: Machine, worktreeId: string, path: string): Promise<void> {
  return machineRequest<void>(machine, 'DELETE', `/worktrees/${worktreeId}/file?path=${encodeURIComponent(path)}`)
}

export function searchWorktreeFiles(machine: Machine, worktreeId: string, pattern: string): Promise<string[]> {
  return machineRequest<string[]>(
    machine,
    'GET',
    `/worktrees/${worktreeId}/files/search?pattern=${encodeURIComponent(pattern)}`,
  )
}

// ---- Worktree git (source control) ----

export interface GitStatusFile {
  path: string
  origPath?: string
  index: string
  worktree: string
}

export interface GitStatus {
  branch: string
  upstream: string
  ahead: number
  behind: number
  files: GitStatusFile[]
}

export interface GitCommit {
  hash: string
  short: string
  author: string
  date: string
  subject: string
  refs: string[]
}

export interface GitDiff {
  path: string
  diff: string
}

export function fetchGitStatus(machine: Machine, worktreeId: string): Promise<GitStatus> {
  return machineRequest<GitStatus>(machine, 'GET', `/worktrees/${worktreeId}/git/status`)
}

export function fetchGitDiff(
  machine: Machine,
  worktreeId: string,
  target: { path: string; staged: boolean; untracked: boolean } | { commit: string },
): Promise<GitDiff> {
  const query =
    'commit' in target
      ? `commit=${encodeURIComponent(target.commit)}`
      : `path=${encodeURIComponent(target.path)}&staged=${target.staged}&untracked=${target.untracked}`
  return machineRequest<GitDiff>(machine, 'GET', `/worktrees/${worktreeId}/git/diff?${query}`)
}

export function fetchGitLog(machine: Machine, worktreeId: string, limit = 50): Promise<GitCommit[]> {
  return machineRequest<GitCommit[]>(machine, 'GET', `/worktrees/${worktreeId}/git/log?limit=${limit}`)
}

export function gitStage(machine: Machine, worktreeId: string, paths: string[]): Promise<void> {
  return machineRequest<void>(machine, 'POST', `/worktrees/${worktreeId}/git/stage`, { paths })
}

export function gitUnstage(machine: Machine, worktreeId: string, paths: string[]): Promise<void> {
  return machineRequest<void>(machine, 'POST', `/worktrees/${worktreeId}/git/unstage`, { paths })
}

/** Discard unstaged changes: tracked files revert, untracked files are deleted. */
export function gitDiscard(machine: Machine, worktreeId: string, paths: string[]): Promise<void> {
  return machineRequest<void>(machine, 'POST', `/worktrees/${worktreeId}/git/discard`, { paths })
}

export function gitCommit(machine: Machine, worktreeId: string, message: string): Promise<void> {
  return machineRequest<void>(machine, 'POST', `/worktrees/${worktreeId}/git/commit`, { message })
}

export function gitPush(machine: Machine, worktreeId: string): Promise<void> {
  return machineRequest<void>(machine, 'POST', `/worktrees/${worktreeId}/git/push`)
}

export function gitPull(machine: Machine, worktreeId: string): Promise<void> {
  return machineRequest<void>(machine, 'POST', `/worktrees/${worktreeId}/git/pull`)
}

// ---- Project branches (the repo lives on this machine's disk) ----

export function fetchProjectBranches(machine: Machine, projectId: string): Promise<string[]> {
  return machineRequest<string[]>(machine, 'GET', `/projects/${projectId}/branches`)
}

// ---- Filesystem (browsing a path on this machine, e.g. for new-project setup) ----

export interface FsListResponse {
  entries: FsEntry[]
  git: boolean
}

export function fetchFsList(machine: Machine, path: string): Promise<FsListResponse> {
  return machineRequest<FsListResponse>(machine, 'GET', `/fs/list?path=${encodeURIComponent(path)}`)
}

export interface CreateFsFolderBody {
  path: string
  name: string
}

export interface CreateFsFolderResponse {
  path: string
}

export function createFsFolder(machine: Machine, body: CreateFsFolderBody): Promise<CreateFsFolderResponse> {
  return machineRequest<CreateFsFolderResponse>(machine, 'POST', '/fs/mkdir', body)
}

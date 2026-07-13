// Typed client for runtime-machine-scoped resources: worktrees, worktree
// files, worktree git, project branches, filesystem browsing, and agent
// management (installed CLI agents, skills, MCP servers, env profiles —
// all properties of a specific machine, not the hub). Every function takes
// the target Machine and resolves direct-vs-proxy through machineClient.ts.
// Hub-scoped resources (workspaces, todos, invoices, ...) stay in api.ts.

import type {
  Agent,
  AgentModel,
  AgentSkill,
  AgentSummary,
  EnvModelOption,
  EnvProfileSummary,
  FsEntry,
  MCPServer,
  Machine,
  TermLine,
  Worktree,
} from '@/store/types'
import { machineRequest } from './machineClient'

// ---- Worktrees ----

export interface CreateWorktreeBody {
  mode: 'branch' | 'root'
  branch?: string
  base?: string
  model: string
  agent: string
  task?: string
  path: string
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

export function fetchProjectBranches(machine: Machine, projectId: string, path: string): Promise<string[]> {
  return machineRequest<string[]>(machine, 'GET', `/projects/${projectId}/branches?path=${encodeURIComponent(path)}`)
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

// ---- Forward proxy (on-demand SOCKS5/HTTP, for the machine-proxied Browser tab) ----

export interface ProxyStartResponse {
  socks5Addr: string
  httpProxyAddr: string
}

/** Idempotently starts this machine's SOCKS5+HTTP forward proxy. A second
 *  call while already running returns the same bound addresses. Unauthenticated
 *  by design — see the comment on the Go service's `Start()`: no Tauri-backed
 *  webview proxy_url on any platform can carry credentials. */
export function startProxy(machine: Machine): Promise<ProxyStartResponse> {
  return machineRequest<ProxyStartResponse>(machine, 'POST', '/proxy/start')
}

// ---- Agents / Models / Skills (installed CLI agents live on the machine) ----

export function fetchAgents(machine: Machine): Promise<AgentSummary[]> {
  return machineRequest<AgentSummary[]>(machine, 'GET', '/agents')
}

export function fetchAgent(machine: Machine, agentId: string): Promise<Agent> {
  return machineRequest<Agent>(machine, 'GET', `/agents/${agentId}`)
}

export function fetchAgentModels(machine: Machine, agentId: string): Promise<AgentModel[]> {
  return machineRequest<AgentModel[]>(machine, 'GET', `/agents/${agentId}/models`)
}

export function fetchAgentSkills(machine: Machine, agentId: string): Promise<AgentSkill[]> {
  return machineRequest<AgentSkill[]>(machine, 'GET', `/agents/${agentId}/skills`)
}

export function installAgentSkill(machine: Machine, agentId: string, skillName: string): Promise<void> {
  return machineRequest<void>(
    machine,
    'POST',
    `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillName)}`,
  )
}

export function removeAgentSkill(machine: Machine, agentId: string, skillName: string): Promise<void> {
  return machineRequest<void>(
    machine,
    'DELETE',
    `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillName)}`,
  )
}

export interface AddMCPServerBody {
  name: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

export function fetchAgentMCPServers(machine: Machine, agentId: string): Promise<MCPServer[]> {
  return machineRequest<MCPServer[]>(machine, 'GET', `/agents/${encodeURIComponent(agentId)}/mcp-servers`)
}

export function addAgentMCPServer(machine: Machine, agentId: string, body: AddMCPServerBody): Promise<void> {
  return machineRequest<void>(machine, 'POST', `/agents/${encodeURIComponent(agentId)}/mcp-servers`, body)
}

export function removeAgentMCPServer(machine: Machine, agentId: string, serverName: string): Promise<void> {
  return machineRequest<void>(
    machine,
    'DELETE',
    `/agents/${encodeURIComponent(agentId)}/mcp-servers/${encodeURIComponent(serverName)}`,
  )
}

// ---- Agent env profiles (Claude LLM-environment snapshots) ----

export interface EnvProfileInput {
  name: string
  baseUrl: string
  authToken: string
  models: Record<string, string>
  extraEnv: Record<string, string>

  // Codex-specific
  codexProviderName?: string
  codexWireAPI?: string
  codexEnvKey?: string
  codexContextWindow?: number
  codexMaxTokens?: number
}

/** A blank authToken on update means "leave the stored token unchanged." */
export interface EnvProfilePatch {
  name: string
  baseUrl: string
  authToken?: string
  models: Record<string, string>
  extraEnv: Record<string, string>

  // Codex-specific
  codexProviderName?: string
  codexWireAPI?: string
  codexEnvKey?: string
  codexContextWindow?: number
  codexMaxTokens?: number
}

export function fetchAgentEnvProfiles(machine: Machine, agentId: string): Promise<EnvProfileSummary[]> {
  return machineRequest<EnvProfileSummary[]>(
    machine,
    'GET',
    `/agents/${encodeURIComponent(agentId)}/env-profiles`,
  )
}

export function fetchAgentEnvProfile(
  machine: Machine,
  agentId: string,
  profileId: string,
): Promise<EnvProfileSummary> {
  return machineRequest<EnvProfileSummary>(
    machine,
    'GET',
    `/agents/${encodeURIComponent(agentId)}/env-profiles/${encodeURIComponent(profileId)}`,
  )
}

export function createAgentEnvProfile(
  machine: Machine,
  agentId: string,
  body: EnvProfileInput,
): Promise<EnvProfileSummary> {
  return machineRequest<EnvProfileSummary>(
    machine,
    'POST',
    `/agents/${encodeURIComponent(agentId)}/env-profiles`,
    body,
  )
}

export function updateAgentEnvProfile(
  machine: Machine,
  agentId: string,
  profileId: string,
  body: EnvProfilePatch,
): Promise<EnvProfileSummary> {
  return machineRequest<EnvProfileSummary>(
    machine,
    'PATCH',
    `/agents/${encodeURIComponent(agentId)}/env-profiles/${encodeURIComponent(profileId)}`,
    body,
  )
}

export function removeAgentEnvProfile(machine: Machine, agentId: string, profileId: string): Promise<void> {
  return machineRequest<void>(
    machine,
    'DELETE',
    `/agents/${encodeURIComponent(agentId)}/env-profiles/${encodeURIComponent(profileId)}`,
  )
}

export function activateAgentEnvProfile(machine: Machine, agentId: string, profileId: string): Promise<void> {
  return machineRequest<void>(
    machine,
    'POST',
    `/agents/${encodeURIComponent(agentId)}/env-profiles/${encodeURIComponent(profileId)}/activate`,
  )
}

export function deactivateAgentEnvProfile(machine: Machine, agentId: string): Promise<void> {
  return machineRequest<void>(
    machine,
    'POST',
    `/agents/${encodeURIComponent(agentId)}/env-profiles/deactivate`,
  )
}

/** When authToken is omitted, the backend uses the stored profile's token. */
export function fetchAgentEnvModels(
  machine: Machine,
  agentId: string,
  body: { profileId?: string; baseUrl: string; authToken?: string },
): Promise<EnvModelOption[]> {
  return machineRequest<EnvModelOption[]>(
    machine,
    'POST',
    `/agents/${encodeURIComponent(agentId)}/env-profiles/fetch-models`,
    body,
  )
}

// ---- Settings file (raw JSON editor) ----

export function fetchAgentSettingsFile(machine: Machine, agentId: string): Promise<{ content: string }> {
  return machineRequest<{ content: string }>(
    machine,
    'GET',
    `/agents/${encodeURIComponent(agentId)}/settings-file`,
  )
}

export function updateAgentSettingsFile(machine: Machine, agentId: string, content: string): Promise<void> {
  return machineRequest<void>(
    machine,
    'PUT',
    `/agents/${encodeURIComponent(agentId)}/settings-file`,
    { content },
  )
}

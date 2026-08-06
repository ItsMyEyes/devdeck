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
  HostStats,
  MCPServer,
  Machine,
  PublishedSOCKSStatus,
  TermLine,
  Worktree,
} from '@/store/types'
import { machineRequest, machineXhr, type TransferProgress } from './machineClient'

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

export function mkdirWorktreeFolder(machine: Machine, worktreeId: string, path: string): Promise<WorktreeFileEntry> {
  return machineRequest<WorktreeFileEntry>(machine, 'POST', `/worktrees/${worktreeId}/files/mkdir`, { path })
}

export function moveWorktreeFile(machine: Machine, worktreeId: string, from: string, to: string): Promise<WorktreeFileEntry> {
  return machineRequest<WorktreeFileEntry>(machine, 'POST', `/worktrees/${worktreeId}/files/move`, { from, to })
}

export function copyWorktreeFile(machine: Machine, worktreeId: string, from: string, to: string): Promise<WorktreeFileEntry> {
  return machineRequest<WorktreeFileEntry>(machine, 'POST', `/worktrees/${worktreeId}/files/copy`, { from, to })
}

export function uploadWorktreeFileWithProgress(
  machine: Machine,
  worktreeId: string,
  folderPath: string,
  file: File,
  onProgress: (progress: TransferProgress) => void,
): Promise<WorktreeFileEntry[]> {
  const form = new FormData()
  form.append('file', file)
  return machineXhr<WorktreeFileEntry[]>(machine, {
    method: 'POST',
    path: `/worktrees/${worktreeId}/files/upload?path=${encodeURIComponent(folderPath)}`,
    body: form,
    onUploadProgress: onProgress,
    responseType: 'json',
  })
}

export function deleteWorktreePaths(machine: Machine, worktreeId: string, paths: readonly string[]): Promise<void> {
  return machineRequest<void>(machine, 'POST', `/worktrees/${worktreeId}/files/delete`, { paths })
}

export function downloadWorktreeZipWithProgress(
  machine: Machine,
  worktreeId: string,
  paths: readonly string[],
  onProgress: (progress: TransferProgress) => void,
): Promise<Blob> {
  return machineXhr<Blob>(machine, {
    method: 'POST',
    path: `/worktrees/${worktreeId}/files/zip`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
    onDownloadProgress: onProgress,
    responseType: 'blob',
  })
}

/** POST .../files/extract — the inverse of downloadWorktreeZipWithProgress:
 *  decompresses `archive` into `folderPath` server-side. Field names
 *  ("archive" file part, "path" form field) match
 *  WorktreeFileHandler.Extract exactly, same multipart shape as
 *  uploadWorktreeFileWithProgress. */
export function extractWorktreeArchiveWithProgress(
  machine: Machine,
  worktreeId: string,
  folderPath: string,
  archive: Blob,
  onProgress: (progress: TransferProgress) => void,
): Promise<WorktreeFileEntry[]> {
  const form = new FormData()
  form.append('archive', archive, 'archive.zip')
  form.append('path', folderPath)
  return machineXhr<WorktreeFileEntry[]>(machine, {
    method: 'POST',
    path: `/worktrees/${worktreeId}/files/extract`,
    body: form,
    onUploadProgress: onProgress,
    responseType: 'json',
  })
}

/** Raw bytes for a single file. Goes through machineXhr rather than a plain
 *  `<a download>` link because direct mode needs an Authorization header,
 *  which an anchor can't carry. */
export function downloadWorktreeFileWithProgress(
  machine: Machine,
  worktreeId: string,
  filePath: string,
  onProgress: (progress: TransferProgress) => void,
): Promise<Blob> {
  return machineXhr<Blob>(machine, {
    method: 'GET',
    path: `/worktrees/${worktreeId}/files/download?path=${encodeURIComponent(filePath)}`,
    onDownloadProgress: onProgress,
    responseType: 'blob',
  })
}

export interface SearchWorktreeFilesOptions {
  includeDirs?: boolean
}

export function searchWorktreeFiles(
  machine: Machine,
  worktreeId: string,
  pattern: string,
  options: SearchWorktreeFilesOptions = {},
): Promise<string[]> {
  const params = new URLSearchParams({ pattern })
  if (options.includeDirs) params.set('includeDirs', '1')
  return machineRequest<string[]>(machine, 'GET', `/worktrees/${worktreeId}/files/search?${params}`)
}

// ---- Worktree content search (grep) ----
//
// Mirrors backend/internal/service/worktree_file.go's GrepOptions/GrepResult
// JSON shape exactly (field names/casing checked against the Go struct tags,
// not the Go field names). Declared once here — rather than per data-source
// file like SearchWorktreeFilesOptions/SearchSSHFilesOptions are — because
// SSHFileService.Grep shares this exact same response shape on the backend
// (same Go types, same package), and GrepFileMatch/GrepMatch's nesting makes
// a field-for-field re-declaration in sshFileApi.ts more error-prone than
// the trivial flat Search*Options duplication is; sshFileApi.ts imports
// these types from here instead.

export interface GrepOptions {
  regex?: boolean
  caseSensitive?: boolean
  includePattern?: string
}

/** Column is a 1-based offset into `text` where the match starts; 0 when the
 *  engine can't report one (the `grep` fallback doesn't emit columns). */
export interface GrepMatch {
  line: number
  column: number
  text: string
}

export interface GrepFileMatch {
  path: string
  matches: GrepMatch[]
}

export interface GrepResult {
  engine: string
  rgAvailable: boolean
  truncated: boolean
  files: GrepFileMatch[]
}

/** Exported so sshFileApi.ts's grepSSHFiles builds an identical query string
 *  without duplicating this option-encoding logic. */
export function grepParams(query: string, options: GrepOptions) {
  const params = new URLSearchParams({ query })
  if (options.regex) params.set('regex', '1')
  if (options.caseSensitive) params.set('caseSensitive', '1')
  if (options.includePattern) params.set('includePattern', options.includePattern)
  return params
}

/** Go's zero-value `[]GrepFileMatch(nil)` (returned whenever neither rg nor
 *  grep is available on the target — see GrepResult's backend doc comment)
 *  has no `omitempty` on its json tag, so it serializes as JSON `null`, not
 *  `[]`. Normalized to `[]` here so callers can rely on `files` always being
 *  a real (possibly empty) array, matching this file's declared GrepResult
 *  type. */
export function normalizeGrepResult(result: GrepResult): GrepResult {
  return result.files ? result : { ...result, files: [] }
}

export async function grepWorktreeFiles(
  machine: Machine,
  worktreeId: string,
  query: string,
  options: GrepOptions = {},
): Promise<GrepResult> {
  const result = await machineRequest<GrepResult>(
    machine,
    'GET',
    `/worktrees/${worktreeId}/files/grep?${grepParams(query, options)}`,
  )
  return normalizeGrepResult(result)
}

/** Mirrors the backend's `{"installed": true, "version": "..."}` success
 *  envelope exactly (see internal/handler/worktree_file.go's InstallRipgrep
 *  and internal/handler/ssh_file.go's InstallRipgrep — same shape on both
 *  routes, declared once here for the same reason GrepResult is). */
export interface InstallRipgrepResult {
  installed: boolean
  version: string
}

/** POST .../grep/install-ripgrep — downloads ripgrep and installs it on
 *  whichever process owns this worktree (the hub for local/unassigned
 *  projects, or the remote runtime process for Machine-assigned ones, via
 *  the existing MachineProxyHandler forwarding). No request body. */
export function installWorktreeRipgrep(machine: Machine, worktreeId: string): Promise<InstallRipgrepResult> {
  return machineRequest<InstallRipgrepResult>(machine, 'POST', `/worktrees/${worktreeId}/files/grep/install-ripgrep`)
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

// ---- Terminal sessions ----

/** Immediately kills a spawned terminal pane's PTY process. A pane's tab
 *  closing in the UI only removes it from the layout — left alone, the PTY
 *  lingers for the reconnect grace period (see registry.detach on the Go
 *  side) instead of exiting right away. The backend refuses this for a
 *  worktree's primary session (bare worktree id, no "::term-N" suffix),
 *  since that one backs the worktree itself and must survive a pane close. */
export function killTerminalSession(machine: Machine, sessionId: string): Promise<void> {
  return machineRequest<void>(machine, 'DELETE', `/terminal/sessions/${encodeURIComponent(sessionId)}`)
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

// ---- Runtime sign-in PIN ----
//
// The hub reaches these with the runtime's own key (machineClient injects it
// direct, or MachineProxyHandler does server-side), which is exactly the
// authority the runtime requires to rotate its PIN. The PIN is never readable
// back — only whether one is set.

export interface MachinePinStatus {
  configured: boolean
  length: number
}

export function fetchMachinePinStatus(machine: Machine): Promise<MachinePinStatus> {
  return machineRequest<MachinePinStatus>(machine, 'GET', '/auth/pin')
}

export function updateMachinePin(machine: Machine, pin: string): Promise<void> {
  return machineRequest<void>(machine, 'PUT', '/auth/pin', { pin })
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

// ---- Published SOCKS5 (persistent, keyed, operator-toggled) ----

export interface PublishedSOCKSRequest {
  enabled: boolean
  /** Omit or 0 to keep the machine's stored port. */
  port?: number
  rotateKey?: boolean
}

/** Reads this machine's persistent SOCKS5 publication. Unlike startProxy's
 *  ephemeral pair, this listener is fixed-port, always keyed, and survives
 *  restart. */
export function fetchPublishedSocks(machine: Machine): Promise<PublishedSOCKSStatus> {
  return machineRequest<PublishedSOCKSStatus>(machine, 'GET', '/proxy/publish')
}

/** Applies publication state live on the machine and persists it. */
export function setPublishedSocks(
  machine: Machine,
  body: PublishedSOCKSRequest,
): Promise<PublishedSOCKSStatus> {
  return machineRequest<PublishedSOCKSStatus>(machine, 'PUT', '/proxy/publish', body)
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

export interface AgentSkillContent {
  path: string
  content: string
  readOnly: boolean
  linked: boolean
}

export function fetchAgentSkillContent(
  machine: Machine,
  agentId: string,
  skillName: string,
): Promise<AgentSkillContent> {
  return machineRequest<AgentSkillContent>(
    machine,
    'GET',
    `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillName)}/content`,
  )
}

export function updateAgentSkillContent(
  machine: Machine,
  agentId: string,
  skillName: string,
  content: string,
): Promise<void> {
  return machineRequest<void>(
    machine,
    'PUT',
    `/agents/${encodeURIComponent(agentId)}/skills/${encodeURIComponent(skillName)}/content`,
    { content },
  )
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

// ---- Language-server dependencies ----

export interface DependencyStatus {
  name: string
  installed: boolean
  path?: string
  version?: string
}

export interface LanguageDependencies {
  label: string
  server: DependencyStatus
  prerequisite: DependencyStatus
  installable: boolean
  blocker?: string
}

export interface DependencyReport {
  languages: LanguageDependencies[]
  /** The PATH a language server is actually spawned with. Surfaced because a
   *  server that resolves fine but cannot reach its own toolchain degrades
   *  silently rather than failing — see backend/internal/lsp/deps.go. */
  spawnPath: string
  os: string
}

/** Read-only probe of this machine's language servers and toolchains. */
export function fetchLspDeps(machine: Machine): Promise<DependencyReport> {
  return machineRequest<DependencyReport>(machine, 'GET', '/lsp/deps')
}

/** Installs one language server and answers with the refreshed report, so the
 *  caller renders the new state without a second round trip. Slow by nature —
 *  `go install` and `npm install -g` take tens of seconds. */
export function installLspDep(machine: Machine, binary: string): Promise<DependencyReport> {
  return machineRequest<DependencyReport>(machine, 'POST', '/lsp/deps/install', { binary })
}

export interface TraceEntry {
  seq: number
  at: string
  kind: string
  detail: string
  worktree?: string
}

/** What DevDeck actually told each language server: spawn root, initialize
 *  params, and every document opened or closed. */
export function fetchLspTrace(machine: Machine): Promise<{ entries: TraceEntry[] }> {
  return machineRequest<{ entries: TraceEntry[] }>(machine, 'GET', '/lsp/trace')
}

export function clearLspTrace(machine: Machine): Promise<{ entries: TraceEntry[] }> {
  return machineRequest<{ entries: TraceEntry[] }>(machine, 'DELETE', '/lsp/trace')
}

// ---- Host metrics ----

/** One live CPU/memory/disk sample from this machine. */
export function fetchMachineStats(machine: Machine): Promise<HostStats> {
  return machineRequest<HostStats>(machine, 'GET', '/system/stats')
}

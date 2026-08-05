// React-query cache keys for domain data.

import type { DBObjectRef, DBRowsRequest, DBTreePath } from '@/lib/api'

export const qk = {
  workspaces: ['workspaces'] as const,
  settings: ['settings'] as const,
  agents: (machineId: string) => ['machines', machineId, 'agents'] as const,
  agentDetail: (machineId: string, id: string) => ['machines', machineId, 'agents', id] as const,
  agentModels: (machineId: string, id: string) => ['machines', machineId, 'agents', id, 'models'] as const,
  agentSkills: (machineId: string, id: string) => ['machines', machineId, 'agents', id, 'skills'] as const,
  agentSkillContent: (machineId: string, id: string, skillName: string) =>
    ['machines', machineId, 'agents', id, 'skills', skillName, 'content'] as const,
  agentMCPServers: (machineId: string, id: string) =>
    ['machines', machineId, 'agents', id, 'mcp-servers'] as const,
  agentEnvProfiles: (machineId: string, id: string) =>
    ['machines', machineId, 'agents', id, 'env-profiles'] as const,
  agentSettingsFile: (machineId: string, id: string) =>
    ['machines', machineId, 'agents', id, 'settings-file'] as const,
  fsList: (machineId: string, path: string) => ['machines', machineId, 'fs', 'list', path] as const,
  worktreeFilesRoot: (machineId: string, id: string) => ['machines', machineId, 'worktrees', id, 'files'] as const,
  worktreeFiles: (machineId: string, id: string, path: string) =>
    ['machines', machineId, 'worktrees', id, 'files', path] as const,
  worktreeFile: (machineId: string, id: string, path: string) =>
    ['machines', machineId, 'worktrees', id, 'file', path] as const,
  /** Raw bytes (documents), kept separate from the UTF-8 text entry above. */
  worktreeFileBytes: (machineId: string, id: string, path: string) =>
    ['machines', machineId, 'worktrees', id, 'file-bytes', path] as const,
  worktreeFileSearch: (machineId: string, id: string, pattern: string) =>
    ['machines', machineId, 'worktrees', id, 'file-search', pattern] as const,
  worktreeGrep: (machineId: string, id: string, query: string) =>
    ['machines', machineId, 'worktrees', id, 'grep', query] as const,
  /** Prefix of worktreeGrep (drops the query text) — lets a successful
   *  install-ripgrep mutation invalidate every cached content-search result
   *  for a target regardless of what was last searched. */
  worktreeGrepRoot: (machineId: string, id: string) => ['machines', machineId, 'worktrees', id, 'grep'] as const,
  /** Machine-scoped, not worktree-scoped: a toolchain belongs to the machine,
   *  so every worktree on it shares one answer. */
  lspDeps: (machineId: string) => ['machines', machineId, 'lsp', 'deps'] as const,
  lspTrace: (machineId: string) => ['machines', machineId, 'lsp', 'trace'] as const,
  gitRoot: (machineId: string, id: string) => ['machines', machineId, 'worktrees', id, 'git'] as const,
  gitStatus: (machineId: string, id: string) => ['machines', machineId, 'worktrees', id, 'git', 'status'] as const,
  gitLog: (machineId: string, id: string) => ['machines', machineId, 'worktrees', id, 'git', 'log'] as const,
  gitDiff: (machineId: string, id: string, target: string) =>
    ['machines', machineId, 'worktrees', id, 'git', 'diff', target] as const,
  projectBranches: (machineId: string, id: string) =>
    ['machines', machineId, 'projects', id, 'branches'] as const,
  companies: ['companies'] as const,
  banks: ['banks'] as const,
  issueAttachments: (issueId: string) => ['issues', issueId, 'attachments'] as const,
  issueComments: (issueId: string) => ['issues', issueId, 'comments'] as const,
  issueEvents: (issueId: string) => ['issues', issueId, 'events'] as const,
  me: ['me'] as const,
  authConfig: ['authConfig'] as const,
  whoami: ['whoami'] as const,
  machines: ['machines'] as const,
  machineHealth: (id: string) => ['machines', id, 'health'] as const,
  machineVersion: (id: string) => ['machines', id, 'version'] as const,
  publishedSocks: (id: string) => ['machines', id, 'publishedSocks'] as const,
  machineUpdateCheck: (id: string) => ['machines', id, 'updateCheck'] as const,
  /** Whether a runtime has a sign-in PIN set. id === '' means this process
   *  itself (a runtime looking at its own PIN), not a remote machine. */
  runtimePinStatus: (id: string) => ['machines', id, 'pinStatus'] as const,
  tailscaleStatus: ['tailscaleStatus'] as const,
  hubKey: ['hubKey'] as const,
  bookmarks: ['bookmarks'] as const,
  sshConnections: ['sshConnections'] as const,
  sshFilesRoot: (connectionId: string) => ['ssh', connectionId, 'files'] as const,
  sshFiles: (connectionId: string, path: string) => ['ssh', connectionId, 'files', path] as const,
  sshFile: (connectionId: string, path: string) => ['ssh', connectionId, 'file', path] as const,
  sshFileBytes: (connectionId: string, path: string) => ['ssh', connectionId, 'file-bytes', path] as const,
  sshFileSearch: (connectionId: string, pattern: string) => ['ssh', connectionId, 'file-search', pattern] as const,
  sshGrep: (connectionId: string, query: string) => ['ssh', connectionId, 'grep', query] as const,
  /** Prefix of sshGrep — see worktreeGrepRoot's comment above. */
  sshGrepRoot: (connectionId: string) => ['ssh', connectionId, 'grep'] as const,
  dbConnections: ['dbConnections'] as const,
  dbEngines: ['dbEngines'] as const,
  dbSavedQueries: (connectionId: string) => ['db', connectionId, 'queries'] as const,
  dbQueryHistory: (connectionId: string) => ['db', connectionId, 'history'] as const,
  dbTree: (connectionId: string, path: DBTreePath) => ['db', connectionId, 'tree', path] as const,
  dbColumns: (connectionId: string, object: DBObjectRef) => ['db', connectionId, 'columns', object] as const,
  /** Prefixes of dbTree/dbColumns (they drop the path/object descriptor) —
   *  the SQL editor reads every cached branch under them to build its
   *  autocomplete schema without issuing a request. */
  dbTreeRoot: (connectionId: string) => ['db', connectionId, 'tree'] as const,
  dbColumnsRoot: (connectionId: string) => ['db', connectionId, 'columns'] as const,
  dbIndexes: (connectionId: string, object: DBObjectRef) => ['db', connectionId, 'indexes', object] as const,
  dbStats: (connectionId: string, object: DBObjectRef) => ['db', connectionId, 'stats', object] as const,
  dbRows: (connectionId: string, req: DBRowsRequest) => ['db', connectionId, 'rows', req] as const,
  dbShowCreate: (connectionId: string, object: DBObjectRef) => ['db', connectionId, 'showCreate', object] as const,
}

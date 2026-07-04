// React-query cache keys for domain data.

export const qk = {
  workspaces: ['workspaces'] as const,
  settings: ['settings'] as const,
  agents: ['agents'] as const,
  agentDetail: (id: string) => ['agents', id] as const,
  agentModels: (id: string) => ['agents', id, 'models'] as const,
  agentSkills: (id: string) => ['agents', id, 'skills'] as const,
  fsList: (path: string) => ['fs', 'list', path] as const,
  worktreeFilesRoot: (id: string) => ['worktrees', id, 'files'] as const,
  worktreeFiles: (id: string, path: string) => ['worktrees', id, 'files', path] as const,
  worktreeFile: (id: string, path: string) => ['worktrees', id, 'file', path] as const,
  worktreeFileSearch: (id: string, pattern: string) =>
    ['worktrees', id, 'file-search', pattern] as const,
  gitRoot: (id: string) => ['worktrees', id, 'git'] as const,
  gitStatus: (id: string) => ['worktrees', id, 'git', 'status'] as const,
  gitLog: (id: string) => ['worktrees', id, 'git', 'log'] as const,
  gitDiff: (id: string, target: string) => ['worktrees', id, 'git', 'diff', target] as const,
  projectBranches: (id: string) => ['projects', id, 'branches'] as const,
  companies: ['companies'] as const,
  banks: ['banks'] as const,
  issueAttachments: (issueId: string) => ['issues', issueId, 'attachments'] as const,
  issueComments: (issueId: string) => ['issues', issueId, 'comments'] as const,
  issueEvents: (issueId: string) => ['issues', issueId, 'events'] as const,
  me: ['me'] as const,
  authConfig: ['authConfig'] as const,
}

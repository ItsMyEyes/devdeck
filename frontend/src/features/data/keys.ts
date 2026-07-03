// React-query cache keys for domain data.

export const qk = {
  workspaces: ['workspaces'] as const,
  settings: ['settings'] as const,
  agents: ['agents'] as const,
  agentDetail: (id: string) => ['agents', id] as const,
  agentModels: (id: string) => ['agents', id, 'models'] as const,
  agentSkills: (id: string) => ['agents', id, 'skills'] as const,
  fsList: (path: string) => ['fs', 'list', path] as const,
  projectBranches: (id: string) => ['projects', id, 'branches'] as const,
  companies: ['companies'] as const,
  banks: ['banks'] as const,
  issueAttachments: (issueId: string) => ['issues', issueId, 'attachments'] as const,
  me: ['me'] as const,
}

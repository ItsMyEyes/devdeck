// React-query hooks: backend is the source of truth for domain data.
// Queries read the full nested workspace tree + settings; mutations invalidate on success.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Workspace } from '@/store/types'
import {
  addAgentMCPServer,
  clearDoneTodos,
  createBank,
  createCompany,
  createComment,
  createInvoice,
  createIssue,
  createNews,
  createProject,
  createRecurringTemplate,
  createTodo,
  createWorkspace,
  createWorktree,
  deleteAttachment,
  deleteBank,
  deleteComment,
  deleteCompany,
  deleteInvoice,
  deleteIssue,
  deleteNews,
  deleteProject,
  deleteRecurringTemplate,
  deleteTodo,
  deleteWorkspace,
  deleteWorktree,
  deleteWorktreeFile,
  fetchAgentModels,
  fetchAgentMCPServers,
  fetchAgentSkills,
  fetchAgents,
  fetchAttachments,
  fetchBanks,
  fetchComments,
  fetchCompanies,
  fetchFsList,
  fetchGitDiff,
  fetchGitLog,
  fetchGitStatus,
  fetchIssueEvents,
  fetchProjectBranches,
  fetchSettings,
  fetchWorktreeFile,
  fetchWorktreeFiles,
  fetchWorkspaces,
  gitCommit,
  gitDiscard,
  gitPull,
  gitPush,
  gitStage,
  gitUnstage,
  installAgentSkill,
  markAllNewsRead,
  removeAgentMCPServer,
  removeAgentSkill,
  searchWorktreeFiles,
  seed,
  uploadAttachment,
  updateBank,
  updateComment,
  updateCompany,
  updateInvoice,
  updateIssue,
  updateNews,
  updateProject,
  updateRecurringTemplate,
  updateSettings,
  updateTodo,
  updateWorkspace,
  updateWorktree,
  writeWorktreeFile,
} from '@/lib/api'
import type {
  AddMCPServerBody,
  CreateBankBody,
  CreateCommentBody,
  CreateCompanyBody,
  CreateInvoiceBody,
  CreateIssueBody,
  CreateNewsBody,
  CreateProjectBody,
  CreateRecurringTemplateBody,
  CreateTodoBody,
  CreateWorkspaceBody,
  CreateWorktreeBody,
  SettingsPatch,
  UpdateBankBody,
  UpdateCommentBody,
  UpdateCompanyBody,
  UpdateInvoiceBody,
  UpdateIssueBody,
  UpdateNewsBody,
  UpdateProjectBody,
  UpdateRecurringTemplateBody,
  UpdateTodoBody,
  UpdateWorkspaceBody,
  UpdateWorktreeBody,
} from '@/lib/api'
import { qk } from './keys'

// ---- Queries ----

export function useWorkspaces() {
  return useQuery({ queryKey: qk.workspaces, queryFn: fetchWorkspaces })
}

/** Convenience hook: the single workspace matching wsId, via a select on useWorkspaces. */
export function useWorkspace(wsId: string | null | undefined) {
  return useQuery({
    queryKey: qk.workspaces,
    queryFn: fetchWorkspaces,
    select: (workspaces: Workspace[]) => workspaces.find((w) => w.id === wsId),
  })
}

export function useSettings() {
  return useQuery({ queryKey: qk.settings, queryFn: fetchSettings })
}

// ---- Mutations ----

function useInvalidateWorkspaces() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: qk.workspaces })
}

export function useUpdateSettings() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: SettingsPatch) => updateSettings(patch),
    // Returning the promise lets the mutate-level onSuccess (navigation) await
    // cache invalidation, so it runs against the fresh tree, not a stale one.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.settings }),
        queryClient.invalidateQueries({ queryKey: qk.workspaces }),
      ]),
  })
}

export function useCreateWorkspace() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: (body: CreateWorkspaceBody = {}) => createWorkspace(body),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateWorkspace() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateWorkspaceBody }) => updateWorkspace(id, patch),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteWorkspace(id),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.workspaces }),
        queryClient.invalidateQueries({ queryKey: qk.settings }),
      ]),
  })
}

export function useCreateProject() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ wsId, body }: { wsId: string; body?: CreateProjectBody }) => createProject(wsId, body),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateProject() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateProjectBody }) => updateProject(id, patch),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteProject() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: () => invalidate(),
  })
}

export function useCreateWorktree() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ projectId, body }: { projectId: string; body: CreateWorktreeBody }) =>
      createWorktree(projectId, body),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateWorktree() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateWorktreeBody }) => updateWorktree(id, patch),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteWorktree() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: (id: string) => deleteWorktree(id),
    onSuccess: () => invalidate(),
  })
}

export function useCreateTodo() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ wsId, body }: { wsId: string; body: CreateTodoBody }) => createTodo(wsId, body),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateTodo() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateTodoBody }) => updateTodo(id, patch),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteTodo() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: (id: string) => deleteTodo(id),
    onSuccess: () => invalidate(),
  })
}

export function useClearDoneTodos() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: (wsId: string) => clearDoneTodos(wsId),
    onSuccess: () => invalidate(),
  })
}

export function useCreateInvoice() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ wsId, body }: { wsId: string; body: CreateInvoiceBody }) => createInvoice(wsId, body),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateInvoice() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateInvoiceBody }) => updateInvoice(id, patch),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteInvoice() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: (id: string) => deleteInvoice(id),
    onSuccess: () => invalidate(),
  })
}

export function useCreateIssue() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ projectId, body }: { projectId: string; body: CreateIssueBody }) => createIssue(projectId, body),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateIssue() {
  const invalidate = useInvalidateWorkspaces()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateIssueBody }) => updateIssue(id, patch),
    // A status/priority/assignee change also records an Activity timeline
    // entry server-side, so the timeline must be refetched alongside the
    // workspace tree, not just on an explicit comment/reply mutation.
    onSuccess: (_iss, { id }) =>
      Promise.all([invalidate(), queryClient.invalidateQueries({ queryKey: qk.issueEvents(id) })]),
  })
}

export function useDeleteIssue() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: (id: string) => deleteIssue(id),
    onSuccess: () => invalidate(),
  })
}

/** All files uploaded to an issue, for the dedicated Attachments view — kept
 *  separate from what's inlined in the markdown description. */
export function useAttachments(issueId: string | undefined) {
  return useQuery({
    queryKey: qk.issueAttachments(issueId ?? ''),
    queryFn: () => fetchAttachments(issueId!),
    enabled: !!issueId,
  })
}

/** Uploads a file from the description editor's toolbar/drag-drop/paste. The
 *  caller inserts the returned attachment's URL directly into the markdown
 *  it's already editing; this also refreshes the Attachments view. */
export function useUploadAttachment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ issueId, file }: { issueId: string; file: File }) => uploadAttachment(issueId, file),
    onSuccess: (_att, { issueId }) => queryClient.invalidateQueries({ queryKey: qk.issueAttachments(issueId) }),
  })
}

export function useDeleteAttachment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string; issueId: string }) => deleteAttachment(id),
    onSuccess: (_void, { issueId }) => queryClient.invalidateQueries({ queryKey: qk.issueAttachments(issueId) }),
  })
}

/** Every comment and reply on an issue, for the Activity tab. */
export function useComments(issueId: string | undefined) {
  return useQuery({
    queryKey: qk.issueComments(issueId ?? ''),
    queryFn: () => fetchComments(issueId!),
    enabled: !!issueId,
  })
}

/** An issue's auto-recorded field-change timeline, for the Activity tab. */
export function useIssueEvents(issueId: string | undefined) {
  return useQuery({
    queryKey: qk.issueEvents(issueId ?? ''),
    queryFn: () => fetchIssueEvents(issueId!),
    enabled: !!issueId,
  })
}

export function useCreateComment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ issueId, body }: { issueId: string; body: CreateCommentBody }) => createComment(issueId, body),
    onSuccess: (_c, { issueId }) => queryClient.invalidateQueries({ queryKey: qk.issueComments(issueId) }),
  })
}

export function useUpdateComment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; issueId: string; patch: UpdateCommentBody }) => updateComment(id, patch),
    onSuccess: (_c, { issueId }) => queryClient.invalidateQueries({ queryKey: qk.issueComments(issueId) }),
  })
}

export function useDeleteComment() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id }: { id: string; issueId: string }) => deleteComment(id),
    onSuccess: (_void, { issueId }) => queryClient.invalidateQueries({ queryKey: qk.issueComments(issueId) }),
  })
}

export function useCreateRecurringTemplate() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ wsId, body }: { wsId: string; body: CreateRecurringTemplateBody }) =>
      createRecurringTemplate(wsId, body),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateRecurringTemplate() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateRecurringTemplateBody }) =>
      updateRecurringTemplate(id, patch),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteRecurringTemplate() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: (id: string) => deleteRecurringTemplate(id),
    onSuccess: () => invalidate(),
  })
}

export function useCompanies() {
  return useQuery({ queryKey: qk.companies, queryFn: fetchCompanies })
}

function useInvalidateCompanies() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: qk.companies })
}

export function useCreateCompany() {
  const invalidate = useInvalidateCompanies()
  return useMutation({
    mutationFn: (body: CreateCompanyBody) => createCompany(body),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateCompany() {
  const invalidate = useInvalidateCompanies()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateCompanyBody }) => updateCompany(id, patch),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteCompany() {
  const invalidate = useInvalidateCompanies()
  return useMutation({
    mutationFn: (id: string) => deleteCompany(id),
    onSuccess: () => invalidate(),
  })
}

export function useBanks() {
  return useQuery({ queryKey: qk.banks, queryFn: fetchBanks })
}

function useInvalidateBanks() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: qk.banks })
}

export function useCreateBank() {
  const invalidate = useInvalidateBanks()
  return useMutation({
    mutationFn: (body: CreateBankBody) => createBank(body),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateBank() {
  const invalidate = useInvalidateBanks()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateBankBody }) => updateBank(id, patch),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteBank() {
  const invalidate = useInvalidateBanks()
  return useMutation({
    mutationFn: (id: string) => deleteBank(id),
    onSuccess: () => invalidate(),
  })
}

export function useCreateNews() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ wsId, body }: { wsId: string; body: CreateNewsBody }) => createNews(wsId, body),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateNews() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateNewsBody }) => updateNews(id, patch),
    onSuccess: () => invalidate(),
  })
}

export function useMarkAllNewsRead() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: (wsId: string) => markAllNewsRead(wsId),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteNews() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: (id: string) => deleteNews(id),
    onSuccess: () => invalidate(),
  })
}

export function useSeed() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => seed(),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.workspaces }),
        queryClient.invalidateQueries({ queryKey: qk.settings }),
      ]),
  })
}

// ---- Agent / Model / Skill queries ----

export function useAgents() {
  return useQuery({ queryKey: qk.agents, queryFn: fetchAgents, staleTime: 300_000 })
}

export function useAgentModels(agentId: string | undefined) {
  return useQuery({
    queryKey: qk.agentModels(agentId ?? ''),
    queryFn: () => fetchAgentModels(agentId!),
    enabled: !!agentId,
    staleTime: 300_000,
  })
}

export function useAgentSkills(agentId: string | undefined) {
  return useQuery({
    queryKey: qk.agentSkills(agentId ?? ''),
    queryFn: () => fetchAgentSkills(agentId!),
    enabled: !!agentId,
    staleTime: 300_000,
  })
}

export function useAgentMCPServers(agentId: string | undefined) {
  return useQuery({
    queryKey: qk.agentMCPServers(agentId ?? ''),
    queryFn: () => fetchAgentMCPServers(agentId!),
    enabled: !!agentId,
    staleTime: 30_000,
    retry: false,
  })
}

export function useInstallAgentSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ agentId, skillName }: { agentId: string; skillName: string }) =>
      installAgentSkill(agentId, skillName),
    onSettled: (_data, _error, variables) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.agents }),
        queryClient.invalidateQueries({ queryKey: qk.agentSkills(variables.agentId) }),
      ]),
  })
}

export function useRemoveAgentSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ agentId, skillName }: { agentId: string; skillName: string }) =>
      removeAgentSkill(agentId, skillName),
    onSettled: (_data, _error, variables) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.agents }),
        queryClient.invalidateQueries({ queryKey: qk.agentSkills(variables.agentId) }),
      ]),
  })
}

export function useAddAgentMCPServer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ agentId, body }: { agentId: string; body: AddMCPServerBody }) =>
      addAgentMCPServer(agentId, body),
    onSettled: (_data, _error, variables) =>
      queryClient.invalidateQueries({ queryKey: qk.agentMCPServers(variables.agentId) }),
  })
}

export function useRemoveAgentMCPServer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ agentId, serverName }: { agentId: string; serverName: string }) =>
      removeAgentMCPServer(agentId, serverName),
    onSettled: (_data, _error, variables) =>
      queryClient.invalidateQueries({ queryKey: qk.agentMCPServers(variables.agentId) }),
  })
}

// ---- Projects ----

export function useProjectBranches(projectId: string | undefined) {
  return useQuery({
    queryKey: qk.projectBranches(projectId ?? ''),
    queryFn: () => fetchProjectBranches(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  })
}

// ---- Filesystem ----

export function useFsList(path: string) {
  return useQuery({
    queryKey: qk.fsList(path),
    queryFn: () => fetchFsList(path),
    enabled: path.length > 0,
    staleTime: 30_000,
  })
}

export function useWorktreeFiles(worktreeId: string, path: string) {
  return useQuery({
    queryKey: qk.worktreeFiles(worktreeId, path),
    queryFn: () => fetchWorktreeFiles(worktreeId, path),
    enabled: worktreeId.length > 0,
  })
}

// ---- Worktree git (source control) ----

export function useGitStatus(worktreeId: string, active: boolean) {
  return useQuery({
    queryKey: qk.gitStatus(worktreeId),
    queryFn: () => fetchGitStatus(worktreeId),
    enabled: worktreeId.length > 0,
    refetchInterval: active ? 5000 : false,
  })
}

export function useGitLog(worktreeId: string, active: boolean) {
  return useQuery({
    queryKey: qk.gitLog(worktreeId),
    queryFn: () => fetchGitLog(worktreeId),
    enabled: worktreeId.length > 0 && active,
  })
}

export function useGitDiff(
  worktreeId: string,
  target: { path: string; staged: boolean; untracked: boolean } | { commit: string } | null,
) {
  const targetKey =
    target === null
      ? ''
      : 'commit' in target
        ? `commit:${target.commit}`
        : `${target.staged ? 'staged' : 'work'}:${target.untracked ? 'new' : 'mod'}:${target.path}`
  return useQuery({
    queryKey: qk.gitDiff(worktreeId, targetKey),
    queryFn: () => fetchGitDiff(worktreeId, target!),
    enabled: worktreeId.length > 0 && target !== null,
    staleTime: 5000,
  })
}

/** Mutation over git state; invalidates status + log + cached diffs on settle. */
function useGitMutation<TVars>(worktreeId: string, mutationFn: (vars: TVars) => Promise<void>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.gitRoot(worktreeId) }),
  })
}

export function useGitStage(worktreeId: string) {
  return useGitMutation(worktreeId, (paths: string[]) => gitStage(worktreeId, paths))
}

export function useGitUnstage(worktreeId: string) {
  return useGitMutation(worktreeId, (paths: string[]) => gitUnstage(worktreeId, paths))
}

/**
 * Discard reverts files on disk, so beyond git state this also invalidates
 * the file tree and any open file contents under the worktree.
 */
export function useGitDiscard(worktreeId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (paths: string[]) => gitDiscard(worktreeId, paths),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['worktrees', worktreeId] }),
  })
}

export function useGitCommit(worktreeId: string) {
  return useGitMutation(worktreeId, (message: string) => gitCommit(worktreeId, message))
}

export function useGitPush(worktreeId: string) {
  return useGitMutation(worktreeId, (_: void) => gitPush(worktreeId))
}

export function useGitPull(worktreeId: string) {
  return useGitMutation(worktreeId, (_: void) => gitPull(worktreeId))
}

/** Refetch every loaded folder level of a worktree's file tree. */
export function useInvalidateWorktreeFiles(worktreeId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(worktreeId) })
}

export function useWorktreeFile(worktreeId: string, path: string) {
  return useQuery({
    queryKey: qk.worktreeFile(worktreeId, path),
    queryFn: () => fetchWorktreeFile(worktreeId, path),
    enabled: worktreeId.length > 0 && path.length > 0,
    staleTime: 0,
  })
}

export function useWorktreeFileSearch(worktreeId: string, pattern: string, enabled: boolean) {
  return useQuery({
    queryKey: qk.worktreeFileSearch(worktreeId, pattern),
    queryFn: () => searchWorktreeFiles(worktreeId, pattern),
    enabled: enabled && worktreeId.length > 0,
    staleTime: 0,
  })
}

export function useWriteWorktreeFile(worktreeId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { path: string; content: string }) => writeWorktreeFile(worktreeId, body),
    onSuccess: (content) => {
      queryClient.setQueryData(qk.worktreeFile(worktreeId, content.path), content)
      return queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(worktreeId) })
    },
  })
}

export function useDeleteWorktreeFile(worktreeId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (path: string) => deleteWorktreeFile(worktreeId, path),
    onSuccess: (_result, path) => {
      queryClient.removeQueries({ queryKey: qk.worktreeFile(worktreeId, path) })
      return queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(worktreeId) })
    },
  })
}

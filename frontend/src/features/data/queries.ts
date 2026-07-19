// React-query hooks: backend is the source of truth for domain data.
// Queries read the full nested workspace tree + settings; mutations invalidate on success.

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { Machine, Workspace } from '@/store/types'
import {
  acceptSSHHostKey,
  clearDoneTodos,
  cloneProject,
  createBank,
  createCompany,
  createComment,
  createInvoice,
  createIssue,
  createNews,
  createMachine,
  createProject,
  createRecurringTemplate,
  createSSHConnection,
  createTodo,
  createWorkspace,
  deleteAttachment,
  deleteBank,
  deleteComment,
  deleteCompany,
  deleteInvoice,
  deleteIssue,
  deleteMachine,
  deleteNews,
  deleteProject,
  deleteRecurringTemplate,
  deleteSSHConnection,
  deleteTodo,
  deleteWorkspace,
  fetchAttachments,
  fetchBanks,
  fetchComments,
  fetchCompanies,
  fetchIssueEvents,
  fetchMachineHealth,
  fetchMachines,
  fetchSettings,
  fetchSSHConnections,
  fetchTailscaleStatus,
  fetchWhoami,
  fetchWorkspaces,
  markAllNewsRead,
  seed,
  uploadAttachment,
  updateBank,
  updateComment,
  updateCompany,
  updateInvoice,
  updateIssue,
  updateMachine,
  updateNews,
  updateProject,
  updateRecurringTemplate,
  updateSettings,
  updateSSHConnection,
  updateTodo,
  updateWorkspace,
} from '@/lib/api'
import type {
  CloneProjectBody,
  CreateBankBody,
  CreateCommentBody,
  CreateCompanyBody,
  CreateInvoiceBody,
  CreateIssueBody,
  CreateMachineBody,
  CreateNewsBody,
  CreateProjectBody,
  CreateRecurringTemplateBody,
  CreateSSHConnectionBody,
  CreateTodoBody,
  CreateWorkspaceBody,
  MachineHealth,
  SettingsPatch,
  UpdateBankBody,
  UpdateCommentBody,
  UpdateCompanyBody,
  UpdateInvoiceBody,
  UpdateIssueBody,
  UpdateMachineBody,
  UpdateNewsBody,
  UpdateProjectBody,
  UpdateRecurringTemplateBody,
  UpdateSSHConnectionBody,
  UpdateTodoBody,
  UpdateWorkspaceBody,
} from '@/lib/api'
import {
  activateAgentEnvProfile,
  addAgentMCPServer,
  createAgentEnvProfile,
  createWorktree,
  deactivateAgentEnvProfile,
  deleteWorktree,
  deleteWorktreeFile,
  deleteWorktreePaths,
  fetchAgentEnvModels,
  fetchAgentEnvProfiles,
  fetchAgentMCPServers,
  fetchAgentModels,
  fetchAgentSettingsFile,
  fetchAgentSkillContent,
  fetchAgentSkills,
  fetchAgents,
  fetchFsList,
  fetchGitDiff,
  fetchGitLog,
  fetchGitStatus,
  fetchProjectBranches,
  fetchWorktreeFile,
  fetchWorktreeFiles,
  gitCommit,
  gitDiscard,
  gitPull,
  gitPush,
  gitStage,
  gitUnstage,
  installAgentSkill,
  killTerminalSession,
  removeAgentEnvProfile,
  removeAgentMCPServer,
  removeAgentSkill,
  searchWorktreeFiles,
  updateAgentEnvProfile,
  updateAgentSettingsFile,
  updateAgentSkillContent,
  updateWorktree,
  writeWorktreeFile,
  createFsFolder,
  type AddMCPServerBody,
  type CreateFsFolderBody,
  type CreateWorktreeBody,
  type EnvProfileInput,
  type EnvProfilePatch,
  type SearchWorktreeFilesOptions,
  type UpdateWorktreeBody,
} from '@/lib/machineApi'
import {
  deleteSSHFile,
  deleteSSHPaths,
  fetchSSHFile,
  fetchSSHFiles,
  searchSSHFiles,
  writeSSHFile,
} from '@/lib/sshFileApi'
import type { FilesTarget } from '@/features/terminal/filesTarget'
import { qk } from './keys'

// ---- Queries ----

export function useWorkspaces() {
  return useQuery({ queryKey: qk.workspaces, queryFn: fetchWorkspaces })
}

/** Reports this process's role (hub vs. runtime); never goes stale on its own. */
export function useWhoami() {
  return useQuery({ queryKey: qk.whoami, queryFn: fetchWhoami, staleTime: Infinity, retry: false })
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

// ---- Machines ----

export function useMachines() {
  return useQuery({ queryKey: qk.machines, queryFn: fetchMachines, staleTime: 10_000 })
}

export function useCreateMachine() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateMachineBody) => createMachine(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.machines }),
  })
}

export function useUpdateMachine() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateMachineBody }) => updateMachine(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.machines }),
  })
}

export function useDeleteMachine() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteMachine(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.machines }),
  })
}

export function useMachineHealth(id: string | undefined) {
  return useQuery({
    queryKey: qk.machineHealth(id ?? ''),
    queryFn: () => fetchMachineHealth(id!),
    enabled: !!id,
    staleTime: 5_000,
    refetchInterval: 15_000,
  })
}

/** Only meaningful when the current page origin is a loopback address
 *  (desktop "Host locally" mode) — MachineDialog gates `enabled` on that
 *  check itself. See
 *  docs/superpowers/specs/2026-07-17-local-hub-tailscale-reachability-design.md. */
export function useTailscaleStatus(enabled: boolean) {
  return useQuery({
    queryKey: qk.tailscaleStatus,
    queryFn: fetchTailscaleStatus,
    enabled,
    staleTime: 5_000,
  })
}

/** Batched health lookup for machine pickers (Select/dropdown option lists) —
 *  one query per machine, same cache entries `useMachineHealth` reads/writes,
 *  reduced to a `machineId -> status` map so callers don't miss-index across
 *  a `useQueries` result array in a machine's own list order. */
export function useMachinesHealth(machines: Machine[]) {
  const results = useQueries({
    queries: machines.map((m) => ({
      queryKey: qk.machineHealth(m.id),
      queryFn: () => fetchMachineHealth(m.id),
      staleTime: 5_000,
      refetchInterval: 15_000,
    })),
  })
  return useMemo(() => {
    const byId = new Map<string, MachineHealth | undefined>()
    machines.forEach((m, i) => byId.set(m.id, results[i]?.data))
    return byId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machines, results])
}

// ---- SSH connections ----

export function useSSHConnections() {
  return useQuery({ queryKey: qk.sshConnections, queryFn: fetchSSHConnections, staleTime: 10_000 })
}

export function useCreateSSHConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateSSHConnectionBody) => createSSHConnection(body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.sshConnections }),
  })
}

export function useUpdateSSHConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateSSHConnectionBody }) => updateSSHConnection(id, patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.sshConnections }),
  })
}

export function useDeleteSSHConnection() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => deleteSSHConnection(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.sshConnections }),
  })
}

export function useAcceptSSHHostKey() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => acceptSSHHostKey(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.sshConnections }),
  })
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

export function useCloneProject() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ wsId, body }: { wsId: string; body: CloneProjectBody }) => cloneProject(wsId, body),
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
    mutationFn: ({ machine, projectId, body }: { machine: Machine; projectId: string; body: CreateWorktreeBody }) =>
      createWorktree(machine, projectId, body),
    onSuccess: () => invalidate(),
  })
}

export function useUpdateWorktree() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ machine, id, patch }: { machine: Machine; id: string; patch: UpdateWorktreeBody }) =>
      updateWorktree(machine, id, patch),
    onSuccess: () => invalidate(),
  })
}

export function useDeleteWorktree() {
  const invalidate = useInvalidateWorkspaces()
  return useMutation({
    mutationFn: ({ machine, id }: { machine: Machine; id: string }) => deleteWorktree(machine, id),
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

// ---- Agent / Model / Skill queries (installed CLI agents live on a machine) ----

export function useAgents(machine: Machine | undefined) {
  return useQuery({
    queryKey: qk.agents(machine?.id ?? ''),
    queryFn: () => fetchAgents(machine!),
    enabled: !!machine,
    staleTime: 300_000,
  })
}

export function useAgentModels(machine: Machine | undefined, agentId: string | undefined) {
  return useQuery({
    queryKey: qk.agentModels(machine?.id ?? '', agentId ?? ''),
    queryFn: () => fetchAgentModels(machine!, agentId!),
    enabled: !!machine && !!agentId,
    staleTime: 300_000,
  })
}

export function useAgentSkills(machine: Machine | undefined, agentId: string | undefined) {
  return useQuery({
    queryKey: qk.agentSkills(machine?.id ?? '', agentId ?? ''),
    queryFn: () => fetchAgentSkills(machine!, agentId!),
    enabled: !!machine && !!agentId,
    staleTime: 300_000,
  })
}

export function useAgentSkillContent(
  machine: Machine | undefined,
  agentId: string | undefined,
  skillName: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: qk.agentSkillContent(machine?.id ?? '', agentId ?? '', skillName ?? ''),
    queryFn: () => fetchAgentSkillContent(machine!, agentId!, skillName!),
    enabled: enabled && !!machine && !!agentId && !!skillName,
    staleTime: 10_000,
    retry: false,
  })
}

export function useUpdateAgentSkillContent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      machine,
      agentId,
      skillName,
      content,
    }: {
      machine: Machine
      agentId: string
      skillName: string
      content: string
    }) => updateAgentSkillContent(machine, agentId, skillName, content),
    onSettled: (_data, _error, { machine, agentId, skillName }) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.agentSkillContent(machine.id, agentId, skillName) }),
        queryClient.invalidateQueries({ queryKey: qk.agentSkills(machine.id, agentId) }),
        queryClient.invalidateQueries({ queryKey: qk.agents(machine.id) }),
      ]),
  })
}

export function useAgentMCPServers(machine: Machine | undefined, agentId: string | undefined) {
  return useQuery({
    queryKey: qk.agentMCPServers(machine?.id ?? '', agentId ?? ''),
    queryFn: () => fetchAgentMCPServers(machine!, agentId!),
    enabled: !!machine && !!agentId,
    staleTime: 30_000,
    retry: false,
  })
}

export function useInstallAgentSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ machine, agentId, skillName }: { machine: Machine; agentId: string; skillName: string }) =>
      installAgentSkill(machine, agentId, skillName),
    onSettled: (_data, _error, variables) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.agents(variables.machine.id) }),
        queryClient.invalidateQueries({ queryKey: qk.agentSkills(variables.machine.id, variables.agentId) }),
      ]),
  })
}

export function useRemoveAgentSkill() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ machine, agentId, skillName }: { machine: Machine; agentId: string; skillName: string }) =>
      removeAgentSkill(machine, agentId, skillName),
    onSettled: (_data, _error, variables) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.agents(variables.machine.id) }),
        queryClient.invalidateQueries({ queryKey: qk.agentSkills(variables.machine.id, variables.agentId) }),
      ]),
  })
}

export function useAddAgentMCPServer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ machine, agentId, body }: { machine: Machine; agentId: string; body: AddMCPServerBody }) =>
      addAgentMCPServer(machine, agentId, body),
    onSettled: (_data, _error, variables) =>
      queryClient.invalidateQueries({ queryKey: qk.agentMCPServers(variables.machine.id, variables.agentId) }),
  })
}

export function useRemoveAgentMCPServer() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ machine, agentId, serverName }: { machine: Machine; agentId: string; serverName: string }) =>
      removeAgentMCPServer(machine, agentId, serverName),
    onSettled: (_data, _error, variables) =>
      queryClient.invalidateQueries({ queryKey: qk.agentMCPServers(variables.machine.id, variables.agentId) }),
  })
}

// ---- Agent env profiles (Claude LLM-environment snapshots) ----

export function useAgentEnvProfiles(machine: Machine | undefined, agentId: string | undefined) {
  return useQuery({
    queryKey: qk.agentEnvProfiles(machine?.id ?? '', agentId ?? ''),
    queryFn: () => fetchAgentEnvProfiles(machine!, agentId!),
    enabled: !!machine && !!agentId,
    staleTime: 30_000,
    retry: false,
  })
}

export function useCreateAgentEnvProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ machine, agentId, body }: { machine: Machine; agentId: string; body: EnvProfileInput }) =>
      createAgentEnvProfile(machine, agentId, body),
    onSettled: (_data, _error, variables) =>
      queryClient.invalidateQueries({ queryKey: qk.agentEnvProfiles(variables.machine.id, variables.agentId) }),
  })
}

export function useUpdateAgentEnvProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      machine,
      agentId,
      profileId,
      body,
    }: {
      machine: Machine
      agentId: string
      profileId: string
      body: EnvProfilePatch
    }) => updateAgentEnvProfile(machine, agentId, profileId, body),
    onSettled: (_data, _error, variables) =>
      queryClient.invalidateQueries({ queryKey: qk.agentEnvProfiles(variables.machine.id, variables.agentId) }),
  })
}

export function useRemoveAgentEnvProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ machine, agentId, profileId }: { machine: Machine; agentId: string; profileId: string }) =>
      removeAgentEnvProfile(machine, agentId, profileId),
    onSettled: (_data, _error, variables) =>
      queryClient.invalidateQueries({ queryKey: qk.agentEnvProfiles(variables.machine.id, variables.agentId) }),
  })
}

export function useActivateAgentEnvProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ machine, agentId, profileId }: { machine: Machine; agentId: string; profileId: string }) =>
      activateAgentEnvProfile(machine, agentId, profileId),
    onSettled: (_data, _error, variables) =>
      queryClient.invalidateQueries({ queryKey: qk.agentEnvProfiles(variables.machine.id, variables.agentId) }),
  })
}

export function useDeactivateAgentEnvProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ machine, agentId }: { machine: Machine; agentId: string }) =>
      deactivateAgentEnvProfile(machine, agentId),
    onSettled: (_data, _error, variables) =>
      queryClient.invalidateQueries({ queryKey: qk.agentEnvProfiles(variables.machine.id, variables.agentId) }),
  })
}

export function useFetchAgentEnvModels() {
  return useMutation({
    mutationFn: ({
      machine,
      agentId,
      body,
    }: {
      machine: Machine
      agentId: string
      body: { profileId?: string; baseUrl: string; authToken?: string }
    }) => fetchAgentEnvModels(machine, agentId, body),
  })
}

// ---- Settings file (raw JSON editor) ----

export function useAgentSettingsFile(machine: Machine | undefined, agentId: string | undefined) {
  return useQuery({
    queryKey: qk.agentSettingsFile(machine?.id ?? '', agentId ?? ''),
    queryFn: () => fetchAgentSettingsFile(machine!, agentId!),
    enabled: !!machine && !!agentId,
    staleTime: 10_000,
    retry: false,
  })
}

export function useUpdateAgentSettingsFile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ machine, agentId, content }: { machine: Machine; agentId: string; content: string }) =>
      updateAgentSettingsFile(machine, agentId, content),
    onSettled: (_data, _error, { machine, agentId }) =>
      queryClient.invalidateQueries({ queryKey: qk.agentSettingsFile(machine.id, agentId) }),
  })
}

// ---- Projects (branches live on the machine that owns the repo) ----

export function useProjectBranches(machine: Machine | undefined, projectId: string | undefined, path: string | undefined) {
  return useQuery({
    queryKey: qk.projectBranches(machine?.id ?? '', projectId ?? ''),
    queryFn: () => fetchProjectBranches(machine!, projectId!, path!),
    enabled: !!machine && !!projectId && !!path,
    staleTime: 30_000,
  })
}

// ---- Filesystem (browsing a path on a specific machine) ----

export function useFsList(machine: Machine | undefined, path: string) {
  return useQuery({
    queryKey: qk.fsList(machine?.id ?? '', path),
    queryFn: () => fetchFsList(machine!, path),
    enabled: !!machine && path.length > 0,
    staleTime: 30_000,
  })
}

export function useCreateFsFolder(machine: Machine | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: CreateFsFolderBody) => createFsFolder(machine!, body),
    onSuccess: (_created, body) => queryClient.invalidateQueries({ queryKey: qk.fsList(machine?.id ?? '', body.path) }),
  })
}

export function useWorktreeFiles(machine: Machine, worktreeId: string, path: string) {
  return useQuery({
    queryKey: qk.worktreeFiles(machine.id, worktreeId, path),
    queryFn: () => fetchWorktreeFiles(machine, worktreeId, path),
    enabled: worktreeId.length > 0,
  })
}

// ---- Worktree git (source control) ----

export function useGitStatus(machine: Machine, worktreeId: string, active: boolean) {
  return useQuery({
    queryKey: qk.gitStatus(machine.id, worktreeId),
    queryFn: () => fetchGitStatus(machine, worktreeId),
    enabled: worktreeId.length > 0,
    refetchInterval: active ? 5000 : false,
  })
}

export function useGitLog(machine: Machine, worktreeId: string, active: boolean) {
  return useQuery({
    queryKey: qk.gitLog(machine.id, worktreeId),
    queryFn: () => fetchGitLog(machine, worktreeId),
    enabled: worktreeId.length > 0 && active,
  })
}

export function useGitDiff(
  machine: Machine,
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
    queryKey: qk.gitDiff(machine.id, worktreeId, targetKey),
    queryFn: () => fetchGitDiff(machine, worktreeId, target!),
    enabled: worktreeId.length > 0 && target !== null,
    staleTime: 5000,
  })
}

/** Mutation over git state; invalidates status + log + cached diffs on settle. */
function useGitMutation<TVars>(machine: Machine, worktreeId: string, mutationFn: (vars: TVars) => Promise<void>) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn,
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.gitRoot(machine.id, worktreeId) }),
  })
}

export function useGitStage(machine: Machine, worktreeId: string) {
  return useGitMutation(machine, worktreeId, (paths: string[]) => gitStage(machine, worktreeId, paths))
}

export function useGitUnstage(machine: Machine, worktreeId: string) {
  return useGitMutation(machine, worktreeId, (paths: string[]) => gitUnstage(machine, worktreeId, paths))
}

/**
 * Discard reverts files on disk, so beyond git state this also invalidates
 * the file tree and any open file contents under the worktree.
 */
export function useGitDiscard(machine: Machine, worktreeId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (paths: string[]) => gitDiscard(machine, worktreeId, paths),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(machine.id, worktreeId) }),
  })
}

export function useGitCommit(machine: Machine, worktreeId: string) {
  return useGitMutation(machine, worktreeId, (message: string) => gitCommit(machine, worktreeId, message))
}

export function useGitPush(machine: Machine, worktreeId: string) {
  return useGitMutation(machine, worktreeId, (_: void) => gitPush(machine, worktreeId))
}

export function useGitPull(machine: Machine, worktreeId: string) {
  return useGitMutation(machine, worktreeId, (_: void) => gitPull(machine, worktreeId))
}

/** Kills one spawned terminal pane's PTY immediately on tab close — see
 *  killTerminalSession's comment on why this can't target a worktree's
 *  primary session. Not tied to any cached query, so no invalidation. */
export function useKillTerminalSession(machine: Machine) {
  return useMutation({
    mutationFn: (sessionId: string) => killTerminalSession(machine, sessionId),
  })
}

/** Refetch every loaded folder level of a worktree's file tree. */
export function useInvalidateWorktreeFiles(machine: Machine, worktreeId: string) {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(machine.id, worktreeId) })
}

export function useWorktreeFile(machine: Machine, worktreeId: string, path: string) {
  return useQuery({
    queryKey: qk.worktreeFile(machine.id, worktreeId, path),
    queryFn: () => fetchWorktreeFile(machine, worktreeId, path),
    enabled: worktreeId.length > 0 && path.length > 0,
    staleTime: 0,
  })
}

export function useWriteWorktreeFile(machine: Machine, worktreeId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { path: string; content: string }) => writeWorktreeFile(machine, worktreeId, body),
    onSuccess: (content) => {
      queryClient.setQueryData(qk.worktreeFile(machine.id, worktreeId, content.path), content)
      return queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(machine.id, worktreeId) })
    },
  })
}

export function useDeleteWorktreeFile(machine: Machine, worktreeId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (path: string) => deleteWorktreeFile(machine, worktreeId, path),
    onSuccess: (_result, path) => {
      queryClient.removeQueries({ queryKey: qk.worktreeFile(machine.id, worktreeId, path) })
      return queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(machine.id, worktreeId) })
    },
  })
}

export function useDeleteWorktreePaths(machine: Machine, worktreeId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (paths: readonly string[]) => deleteWorktreePaths(machine, worktreeId, paths),
    onSuccess: (_result, paths) => {
      for (const path of paths) queryClient.removeQueries({ queryKey: qk.worktreeFile(machine.id, worktreeId, path) })
      return queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(machine.id, worktreeId) })
    },
  })
}

// ---- File source dispatch (worktree checkout | SSH connection over SFTP) ----
//
// TerminalExplorer.tsx, SSHFileEditor.tsx and FileQuickOpen.tsx are shared
// across both file sources; these hooks pick the right cache key + API call
// for whichever FilesTarget they're handed, so the two sources never need
// their own parallel copy of the shared UI. The plain worktree-only hooks
// above stay untouched — FileEditor.tsx keeps calling those directly.

export function useFilesList(target: FilesTarget, path: string) {
  return useQuery({
    queryKey:
      target.kind === 'ssh' ? qk.sshFiles(target.connectionId, path) : qk.worktreeFiles(target.machine.id, target.worktreeId, path),
    queryFn: () =>
      target.kind === 'ssh' ? fetchSSHFiles(target.connectionId, path) : fetchWorktreeFiles(target.machine, target.worktreeId, path),
    enabled: target.kind === 'ssh' || target.worktreeId.length > 0,
  })
}

export function useFileSearchTarget(
  target: FilesTarget,
  pattern: string,
  enabled: boolean,
  options: SearchWorktreeFilesOptions = {},
) {
  const mode = options.includeDirs ? 'with-dirs' : 'files-only'
  return useQuery({
    queryKey: [
      ...(target.kind === 'ssh'
        ? qk.sshFileSearch(target.connectionId, pattern)
        : qk.worktreeFileSearch(target.machine.id, target.worktreeId, pattern)),
      mode,
    ] as const,
    queryFn: () =>
      target.kind === 'ssh'
        ? searchSSHFiles(target.connectionId, pattern, options)
        : searchWorktreeFiles(target.machine, target.worktreeId, pattern, options),
    enabled: enabled && (target.kind === 'ssh' || target.worktreeId.length > 0),
    staleTime: 0,
  })
}

export function useFileTarget(target: FilesTarget, path: string) {
  return useQuery({
    queryKey:
      target.kind === 'ssh' ? qk.sshFile(target.connectionId, path) : qk.worktreeFile(target.machine.id, target.worktreeId, path),
    queryFn: () =>
      target.kind === 'ssh' ? fetchSSHFile(target.connectionId, path) : fetchWorktreeFile(target.machine, target.worktreeId, path),
    enabled: (target.kind === 'ssh' || target.worktreeId.length > 0) && path.length > 0,
    staleTime: 0,
  })
}

export function useInvalidateFilesTarget(target: FilesTarget) {
  const queryClient = useQueryClient()
  return () =>
    queryClient.invalidateQueries({
      queryKey: target.kind === 'ssh' ? qk.sshFilesRoot(target.connectionId) : qk.worktreeFilesRoot(target.machine.id, target.worktreeId),
    })
}

export function useWriteFileTarget(target: FilesTarget) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (body: { path: string; content: string }) =>
      target.kind === 'ssh' ? writeSSHFile(target.connectionId, body) : writeWorktreeFile(target.machine, target.worktreeId, body),
    onSuccess: (content) => {
      if (target.kind === 'ssh') {
        queryClient.setQueryData(qk.sshFile(target.connectionId, content.path), content)
        return queryClient.invalidateQueries({ queryKey: qk.sshFilesRoot(target.connectionId) })
      }
      queryClient.setQueryData(qk.worktreeFile(target.machine.id, target.worktreeId, content.path), content)
      return queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(target.machine.id, target.worktreeId) })
    },
  })
}

export function useDeleteFileTarget(target: FilesTarget) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (path: string) =>
      target.kind === 'ssh' ? deleteSSHFile(target.connectionId, path) : deleteWorktreeFile(target.machine, target.worktreeId, path),
    onSuccess: (_result, path) => {
      if (target.kind === 'ssh') {
        queryClient.removeQueries({ queryKey: qk.sshFile(target.connectionId, path) })
        return queryClient.invalidateQueries({ queryKey: qk.sshFilesRoot(target.connectionId) })
      }
      queryClient.removeQueries({ queryKey: qk.worktreeFile(target.machine.id, target.worktreeId, path) })
      return queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(target.machine.id, target.worktreeId) })
    },
  })
}

export function useDeletePathsTarget(target: FilesTarget) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (paths: readonly string[]) =>
      target.kind === 'ssh' ? deleteSSHPaths(target.connectionId, paths) : deleteWorktreePaths(target.machine, target.worktreeId, paths),
    onSuccess: (_result, paths) => {
      if (target.kind === 'ssh') {
        for (const path of paths) queryClient.removeQueries({ queryKey: qk.sshFile(target.connectionId, path) })
        return queryClient.invalidateQueries({ queryKey: qk.sshFilesRoot(target.connectionId) })
      }
      for (const path of paths) queryClient.removeQueries({ queryKey: qk.worktreeFile(target.machine.id, target.worktreeId, path) })
      return queryClient.invalidateQueries({ queryKey: qk.worktreeFilesRoot(target.machine.id, target.worktreeId) })
    },
  })
}

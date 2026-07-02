// React-query hooks: backend is the source of truth for domain data.
// Queries read the full nested workspace tree + settings; mutations invalidate on success.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { Workspace } from '@/store/types'
import {
  clearDoneTodos,
  createBank,
  createCompany,
  createInvoice,
  createNews,
  createProject,
  createTodo,
  createWorkspace,
  createWorktree,
  deleteBank,
  deleteCompany,
  deleteInvoice,
  deleteNews,
  deleteProject,
  deleteTodo,
  deleteWorkspace,
  deleteWorktree,
  fetchAgentModels,
  fetchAgentSkills,
  fetchAgents,
  fetchBanks,
  fetchCompanies,
  fetchFsList,
  fetchProjectBranches,
  fetchSettings,
  fetchWorkspaces,
  markAllNewsRead,
  seed,
  updateBank,
  updateCompany,
  updateInvoice,
  updateNews,
  updateProject,
  updateSettings,
  updateTodo,
  updateWorkspace,
  updateWorktree,
} from '@/lib/api'
import type {
  CreateBankBody,
  CreateCompanyBody,
  CreateInvoiceBody,
  CreateNewsBody,
  CreateProjectBody,
  CreateTodoBody,
  CreateWorkspaceBody,
  CreateWorktreeBody,
  SettingsPatch,
  UpdateBankBody,
  UpdateCompanyBody,
  UpdateInvoiceBody,
  UpdateNewsBody,
  UpdateProjectBody,
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


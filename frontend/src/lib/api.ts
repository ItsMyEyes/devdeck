// Typed fetch client for the loom Go + SQLite backend.
// The backend is the source of truth; these functions mirror the REST contract.

import type {
  Agent,
  AgentModel,
  AgentSkill,
  AgentSummary,
  Attachment,
  Bank,
  Company,
  FsEntry,
  Invoice,
  InvoiceItem,
  InvoiceStatus,
  Issue,
  NewsItem,
  Priority,
  Project,
  RecurringInvoiceTemplate,
  Settings,
  TermLine,
  Todo,
  Workspace,
  Worktree,
} from '@/store/types'

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'

/** Error thrown for any non-2xx API response. */
export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

async function request<T>(method: HttpMethod, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method }
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, init)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network request failed'
    throw new ApiError(message, 0)
  }

  if (!res.ok) {
    let message = `Request failed with status ${res.status}`
    try {
      const data = (await res.json()) as { error?: string }
      if (data && typeof data.error === 'string') message = data.error
    } catch {
      // response had no JSON body; keep the default message
    }
    throw new ApiError(message, res.status)
  }

  if (res.status === 204) return undefined as T

  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text) as T
}

// ---- Payload shapes (mirror the REST contract) ----

export interface SettingsPatch {
  activeWorkspaceId?: string | null
  defaultModel?: string
}

export interface CreateWorkspaceBody {
  name?: string
}

export interface UpdateWorkspaceBody {
  name?: string
}

export interface CreateProjectBody {
  name?: string
  path?: string
  repo?: string
}

export interface UpdateProjectBody {
  name?: string
  path?: string
  repo?: string
  expanded?: boolean
}

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

export interface CreateTodoBody {
  text: string
  priority?: Priority
}

export interface UpdateTodoBody {
  text?: string
  done?: boolean
  priority?: Priority
}

export interface CreateInvoiceBody {
  number?: string
  companyName?: string
  companyAddress?: string
  items?: InvoiceItem[]
  dueDate?: string
  status?: InvoiceStatus
  bankName?: string
  bankAccountName?: string
  bankAccountNumber?: string
}

export interface UpdateInvoiceBody {
  number?: string
  companyName?: string
  companyAddress?: string
  items?: InvoiceItem[]
  dueDate?: string
  status?: InvoiceStatus
  bankName?: string
  bankAccountName?: string
  bankAccountNumber?: string
}

export interface CreateCompanyBody {
  name?: string
  shortAddress?: string
}

export interface UpdateCompanyBody {
  name?: string
  shortAddress?: string
}

export interface CreateBankBody {
  bankName?: string
  accountName?: string
  accountNumber?: string
}

export interface UpdateBankBody {
  bankName?: string
  accountName?: string
  accountNumber?: string
}

export interface CreateRecurringTemplateBody {
  companyName?: string
  companyAddress?: string
  items?: InvoiceItem[]
  bankName?: string
  bankAccountName?: string
  bankAccountNumber?: string
  dayOfMonth?: number
  paymentTermDays?: number
}

export interface UpdateRecurringTemplateBody {
  companyName?: string
  companyAddress?: string
  items?: InvoiceItem[]
  bankName?: string
  bankAccountName?: string
  bankAccountNumber?: string
  dayOfMonth?: number
  paymentTermDays?: number
  active?: boolean
}

export interface CreateNewsBody {
  source: string
  title: string
  tag: string
  time: string
  unread?: boolean
}

export interface UpdateNewsBody {
  unread?: boolean
}

export interface CreateIssueBody {
  title: string
  status?: Issue['status']
}

export interface UpdateIssueBody {
  title?: string
  description?: string
  status?: Issue['status']
  priority?: Priority
  position?: number
  assignee?: string | null
}

// ---- Queries ----

export function fetchWorkspaces(): Promise<Workspace[]> {
  return request<Workspace[]>('GET', '/workspaces')
}

export function fetchSettings(): Promise<Settings> {
  return request<Settings>('GET', '/settings')
}

// ---- Settings ----

export function updateSettings(patch: SettingsPatch): Promise<Settings> {
  return request<Settings>('PUT', '/settings', patch)
}

// ---- Workspaces ----

export function createWorkspace(body: CreateWorkspaceBody = {}): Promise<Workspace> {
  return request<Workspace>('POST', '/workspaces', body)
}

export function updateWorkspace(id: string, patch: UpdateWorkspaceBody): Promise<Workspace> {
  return request<Workspace>('PATCH', `/workspaces/${id}`, patch)
}

export function deleteWorkspace(id: string): Promise<void> {
  return request<void>('DELETE', `/workspaces/${id}`)
}

// ---- Projects ----

export function createProject(wsId: string, body: CreateProjectBody = {}): Promise<Project> {
  return request<Project>('POST', `/workspaces/${wsId}/projects`, body)
}

export function updateProject(id: string, patch: UpdateProjectBody): Promise<Project> {
  return request<Project>('PATCH', `/projects/${id}`, patch)
}

export function deleteProject(id: string): Promise<void> {
  return request<void>('DELETE', `/projects/${id}`)
}

export function fetchProjectBranches(id: string): Promise<string[]> {
  return request<string[]>('GET', `/projects/${id}/branches`)
}

// ---- Worktrees ----

export function createWorktree(projectId: string, body: CreateWorktreeBody): Promise<Worktree> {
  return request<Worktree>('POST', `/projects/${projectId}/worktrees`, body)
}

export function updateWorktree(id: string, patch: UpdateWorktreeBody): Promise<Worktree> {
  return request<Worktree>('PATCH', `/worktrees/${id}`, patch)
}

export function deleteWorktree(id: string): Promise<void> {
  return request<void>('DELETE', `/worktrees/${id}`)
}

// ---- Todos ----

export function createTodo(wsId: string, body: CreateTodoBody): Promise<Todo> {
  return request<Todo>('POST', `/workspaces/${wsId}/todos`, body)
}

export function updateTodo(id: string, patch: UpdateTodoBody): Promise<Todo> {
  return request<Todo>('PATCH', `/todos/${id}`, patch)
}

export function deleteTodo(id: string): Promise<void> {
  return request<void>('DELETE', `/todos/${id}`)
}

export function clearDoneTodos(wsId: string): Promise<{ deleted: number }> {
  return request<{ deleted: number }>('POST', `/workspaces/${wsId}/todos/clear-done`)
}

// ---- Invoices ----

export function createInvoice(wsId: string, body: CreateInvoiceBody): Promise<Invoice> {
  return request<Invoice>('POST', `/workspaces/${wsId}/invoices`, body)
}

export function updateInvoice(id: string, patch: UpdateInvoiceBody): Promise<Invoice> {
  return request<Invoice>('PATCH', `/invoices/${id}`, patch)
}

export function deleteInvoice(id: string): Promise<void> {
  return request<void>('DELETE', `/invoices/${id}`)
}

// ---- Companies ----

export function fetchCompanies(): Promise<Company[]> {
  return request<Company[]>('GET', '/companies')
}

export function createCompany(body: CreateCompanyBody): Promise<Company> {
  return request<Company>('POST', '/companies', body)
}

export function updateCompany(id: string, patch: UpdateCompanyBody): Promise<Company> {
  return request<Company>('PATCH', `/companies/${id}`, patch)
}

export function deleteCompany(id: string): Promise<void> {
  return request<void>('DELETE', `/companies/${id}`)
}

// ---- Banks ----

export function fetchBanks(): Promise<Bank[]> {
  return request<Bank[]>('GET', '/banks')
}

export function createBank(body: CreateBankBody): Promise<Bank> {
  return request<Bank>('POST', '/banks', body)
}

export function updateBank(id: string, patch: UpdateBankBody): Promise<Bank> {
  return request<Bank>('PATCH', `/banks/${id}`, patch)
}

export function deleteBank(id: string): Promise<void> {
  return request<void>('DELETE', `/banks/${id}`)
}

// ---- Recurring templates ----

export function createRecurringTemplate(wsId: string, body: CreateRecurringTemplateBody): Promise<RecurringInvoiceTemplate> {
  return request<RecurringInvoiceTemplate>('POST', `/workspaces/${wsId}/recurring-templates`, body)
}

export function updateRecurringTemplate(id: string, patch: UpdateRecurringTemplateBody): Promise<RecurringInvoiceTemplate> {
  return request<RecurringInvoiceTemplate>('PATCH', `/recurring-templates/${id}`, patch)
}

export function deleteRecurringTemplate(id: string): Promise<void> {
  return request<void>('DELETE', `/recurring-templates/${id}`)
}

// ---- News ----

export function createNews(wsId: string, body: CreateNewsBody): Promise<NewsItem> {
  return request<NewsItem>('POST', `/workspaces/${wsId}/news`, body)
}

export function updateNews(id: string, patch: UpdateNewsBody): Promise<NewsItem> {
  return request<NewsItem>('PATCH', `/news/${id}`, patch)
}

export function markAllNewsRead(wsId: string): Promise<{ updated: number }> {
  return request<{ updated: number }>('POST', `/workspaces/${wsId}/news/read-all`)
}

export function deleteNews(id: string): Promise<void> {
  return request<void>('DELETE', `/news/${id}`)
}

// ---- Issues ----

export function createIssue(projectId: string, body: CreateIssueBody): Promise<Issue> {
  return request<Issue>('POST', `/projects/${projectId}/issues`, body)
}

export function updateIssue(id: string, patch: UpdateIssueBody): Promise<Issue> {
  return request<Issue>('PATCH', `/issues/${id}`, patch)
}

export function deleteIssue(id: string): Promise<void> {
  return request<void>('DELETE', `/issues/${id}`)
}

// ---- Attachments ----

/** Direct src/href for a previously uploaded attachment. */
export function attachmentUrl(id: string): string {
  return `${API_BASE}/attachments/${id}`
}

export async function uploadAttachment(issueId: string, file: File): Promise<Attachment> {
  const form = new FormData()
  form.append('file', file)

  let res: Response
  try {
    res = await fetch(`${API_BASE}/issues/${issueId}/attachments`, { method: 'POST', body: form })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network request failed'
    throw new ApiError(message, 0)
  }

  if (!res.ok) {
    let message = `Request failed with status ${res.status}`
    try {
      const data = (await res.json()) as { error?: string }
      if (data && typeof data.error === 'string') message = data.error
    } catch {
      // response had no JSON body; keep the default message
    }
    throw new ApiError(message, res.status)
  }

  return res.json() as Promise<Attachment>
}

export function fetchAttachments(issueId: string): Promise<Attachment[]> {
  return request<Attachment[]>('GET', `/issues/${issueId}/attachments`)
}

export function deleteAttachment(id: string): Promise<void> {
  return request<void>('DELETE', `/attachments/${id}`)
}

// ---- Seed ----

export function seed(): Promise<Workspace[]> {
  return request<Workspace[]>('POST', '/seed')
}

// ---- Agents / Models / Skills ----

export function fetchAgents(): Promise<AgentSummary[]> {
  return request<AgentSummary[]>('GET', '/agents')
}

export function fetchAgent(agentId: string): Promise<Agent> {
  return request<Agent>(`GET`, `/agents/${agentId}`)
}

export function fetchAgentModels(agentId: string): Promise<AgentModel[]> {
  return request<AgentModel[]>('GET', `/agents/${agentId}/models`)
}

export function fetchAgentSkills(agentId: string): Promise<AgentSkill[]> {
  return request<AgentSkill[]>('GET', `/agents/${agentId}/skills`)
}

// ---- Filesystem ----

export interface FsListResponse {
  entries: FsEntry[]
  git: boolean
}

export function fetchFsList(path: string): Promise<FsListResponse> {
  return request<FsListResponse>('GET', `/fs/list?path=${encodeURIComponent(path)}`)
}

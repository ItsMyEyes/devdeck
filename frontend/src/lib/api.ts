// Typed fetch client for the devdeck Go + SQLite backend.
// The backend is the source of truth; these functions mirror the REST contract.

import { parseContentDispositionFilename } from '@/lib/contentDisposition'
// Type-only (erased at build time, so no import cycle with machineClient.ts,
// which imports `request` from here): the PUT /proxy/publish body is the same
// contract whether it is addressed to a remote machine or to this process, so
// it is declared once, next to the per-machine calls.
import type { PublishedSOCKSRequest } from '@/lib/machineApi'
import type {
  Attachment,
  Bank,
  Bookmark,
  Company,
  DBConnection,
  DBEngine,
  DBQueryHistoryEntry,
  DBSavedQuery,
  HostStats,
  Invoice,
  InvoiceItem,
  InvoiceStatus,
  Issue,
  IssueComment,
  IssueEvent,
  Machine,
  NewsItem,
  Priority,
  Project,
  PublishedSOCKSStatus,
  RecurringInvoiceTemplate,
  Settings,
  SSHConnection,
  SSHForward,
  SSHForwardState,
  Todo,
  User,
  Whoami,
  Workspace,
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

/** Builds the ApiError for a non-2xx response, reading the `{"error"}` envelope. */
async function toApiError(res: Response): Promise<ApiError> {
  let message = `Request failed with status ${res.status}`
  try {
    const data = (await res.json()) as { error?: string }
    if (data && typeof data.error === 'string') message = data.error
  } catch {
    // response had no JSON body; keep the default message
  }
  // The server's --only-from IP allowlist rejected us mid-session (the SPA was
  // already loaded); every request will fail, so show the dedicated page.
  if (
    res.status === 403 &&
    message.startsWith('access denied') &&
    window.location.pathname !== '/access-denied'
  ) {
    window.location.assign('/access-denied')
  }
  return new ApiError(message, res.status)
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface RequestOpts {
  /** Overrides API_BASE — used by machineClient.ts to target a runtime machine directly or via the hub proxy. */
  base?: string
  /** Extra headers merged in alongside Content-Type (e.g. a runtime's bearer key). */
  headers?: Record<string, string>
  /** Aborts the underlying fetch when triggered — used by callers (e.g. inline
   *  completions) that need a superseded request to actually stop the
   *  in-flight network call, not just have its result discarded client-side. */
  signal?: AbortSignal
}

export async function request<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  opts?: RequestOpts,
): Promise<T> {
  const init: RequestInit = { method }
  if (opts?.signal) init.signal = opts.signal
  const headers: Record<string, string> = { ...opts?.headers }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  if (Object.keys(headers).length > 0) init.headers = headers

  let res: Response
  try {
    res = await fetch(`${opts?.base ?? API_BASE}${path}`, init)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network request failed'
    throw new ApiError(message, 0)
  }

  if (!res.ok) {
    throw await toApiError(res)
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
  machineId?: string
}

export interface CloneProjectBody {
  name?: string
  path: string
  repo: string
  machineId?: string
}

export interface UpdateProjectBody {
  name?: string
  path?: string
  repo?: string
  machineId?: string
  expanded?: boolean
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

export interface CreateCommentBody {
  author: string
  body: string
  /** Set to reply to an existing comment; omit for a top-level comment. */
  parentId?: string | null
}

export interface UpdateCommentBody {
  body: string
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

// ---- Completions ----

export interface CompletionsConfig {
  provider: 'anthropic' | 'openai-compatible'
  baseUrl: string
  model: string
  enabled: boolean
  configured: boolean
}

export interface CompletionsConfigPatch {
  provider?: 'anthropic' | 'openai-compatible'
  baseUrl?: string
  model?: string
  enabled?: boolean
  apiKey?: string
}

export function fetchCompletionsConfig(): Promise<CompletionsConfig> {
  return request<CompletionsConfig>('GET', '/completions/config')
}

export function updateCompletionsConfig(patch: CompletionsConfigPatch): Promise<CompletionsConfig> {
  return request<CompletionsConfig>('PUT', '/completions/config', patch)
}

export interface GroundingSymbol {
  name: string
  kind: string
  detail: string
}

export interface InlineCompletionRequest {
  prefix: string
  suffix: string
  language: string
  groundingSymbols: GroundingSymbol[]
}

export interface InlineCompletionResult {
  completion: string
}

// request<T>() already returns undefined on a 204 (see toApiError/request
// above) — an unconfigured or disabled completions feature is exactly that
// case, not an error.
export function requestInlineCompletion(
  req: InlineCompletionRequest,
  opts?: RequestOpts,
): Promise<InlineCompletionResult | undefined> {
  return request<InlineCompletionResult | undefined>('POST', '/completions/inline', req, opts)
}

// ---- Memory (persistent agent memory, Hindsight-backed) ----
//
// Hub-only, like Completions above — see domain.MemoryConfig's doc comment
// on the Go side for why. `Enabled`/`AutoRecall` etc. mirror the backend's
// camelCase config DTO; the browse types below (MemoryBankStats,
// MemoryUnit, MemoryGraph*) instead mirror Hindsight's OWN wire shape
// (snake_case) verbatim, on purpose — the handler passes those through
// untouched (see backend/internal/handler/memory.go's doc comment) so the
// Memory page renders whatever Hindsight actually has rather than a
// DevDeck-side model that could quietly drift from it.

/** "manual": an operator-supplied BaseURL (their own server, a cloud
 *  account). "container": the hub manages a docker/podman container on its
 *  own machine. "baremetal": the hub manages a plain OS process (uvx
 *  hindsight-api, or an already-installed hindsight-api binary) — the
 *  fallback when neither docker nor podman is present. See
 *  backend/internal/memoryhost's package comment for the full picture. */
export type MemoryHosting = 'manual' | 'container' | 'baremetal'

export interface MemoryConfig {
  enabled: boolean
  baseUrl: string
  bankId: string
  hosting: MemoryHosting
  localPort: number
  localRunning: boolean
  llmProvider: 'openai' | 'anthropic' | 'gemini' | 'groq' | 'ollama' | 'lmstudio'
  llmModel: string
  llmBaseUrl: string
  autoRecall: boolean
  autoRetain: boolean
  recallBudget: 'low' | 'mid' | 'high'
  maxTokens: number
  configured: boolean
}

export interface MemoryConfigPatch {
  enabled?: boolean
  baseUrl?: string
  bankId?: string
  hosting?: MemoryHosting
  localPort?: number
  llmProvider?: MemoryConfig['llmProvider']
  llmModel?: string
  llmBaseUrl?: string
  autoRecall?: boolean
  autoRetain?: boolean
  recallBudget?: MemoryConfig['recallBudget']
  maxTokens?: number
  apiKey?: string
  llmApiKey?: string
}

/** Mirrors backend/internal/memoryhost.Status — a snapshot of whatever
 *  locally managed container/process this hub might have. */
export interface MemoryLocalStatus {
  available: boolean
  detected?: string // "docker" | "podman" | "hindsight-api" | "uvx"
  binaryPath?: string
  exists: boolean
  running: boolean
  detail?: string
}

export function fetchMemoryLocalStatus(): Promise<MemoryLocalStatus> {
  return request<MemoryLocalStatus>('GET', '/memory/local/status')
}

export function startMemoryLocal(): Promise<MemoryLocalStatus> {
  return request<MemoryLocalStatus>('POST', '/memory/local/start')
}

export function stopMemoryLocal(): Promise<MemoryLocalStatus> {
  return request<MemoryLocalStatus>('POST', '/memory/local/stop')
}

export function fetchMemoryLocalLogs(tail = 200): Promise<{ logs: string }> {
  return request<{ logs: string }>('GET', `/memory/local/logs?tail=${tail}`)
}

export function fetchMemoryConfig(): Promise<MemoryConfig> {
  return request<MemoryConfig>('GET', '/memory/config')
}

export function updateMemoryConfig(patch: MemoryConfigPatch): Promise<MemoryConfig> {
  return request<MemoryConfig>('PUT', '/memory/config', patch)
}

export function testMemoryConnection(baseUrl: string, apiKey: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('POST', '/memory/test', { baseUrl, apiKey })
}

export interface MemoryBankStats {
  bank_id: string
  total_nodes: number
  total_links: number
  total_documents: number
  total_observations: number
  nodes_by_fact_type: Record<string, number>
  links_by_link_type: Record<string, number>
  pending_operations: number
  failed_operations: number
  last_consolidated_at?: string
  last_memory_write_at?: string
}

export function fetchMemoryStats(): Promise<MemoryBankStats> {
  return request<MemoryBankStats>('GET', '/memory/stats')
}

export interface MemoryTagItem {
  tag: string
  count: number
}

export interface MemoryTagsResponse {
  items: MemoryTagItem[]
  total: number
  limit: number
  offset: number
}

export function fetchMemoryTags(params: { q?: string } = {}): Promise<MemoryTagsResponse> {
  const qs = params.q ? `?q=${encodeURIComponent(params.q)}` : ''
  return request<MemoryTagsResponse>('GET', `/memory/tags${qs}`)
}

/** One retained memory unit, as Hindsight itself represents it. Every field
 *  beyond `id` is optional defensively — `GET /memory/memories`' items are
 *  typed as bare objects in Hindsight's own OpenAPI schema, not a fixed
 *  contract, so a page rendering this must tolerate an absent field rather
 *  than crash on it. */
export interface MemoryUnit {
  id: string
  text?: string
  type?: 'world' | 'experience' | 'observation' | string
  context?: string
  tags?: string[]
  entities?: string[]
  metadata?: Record<string, unknown>
  mentioned_at?: string
  occurred_start?: string
  occurred_end?: string
  document_id?: string
  state?: string
  [key: string]: unknown
}

export interface MemoryListResponse {
  items: MemoryUnit[]
  total: number
  limit: number
  offset: number
}

export function fetchMemoryUnits(params: {
  type?: string
  q?: string
  tags?: string[]
  limit?: number
  offset?: number
} = {}): Promise<MemoryListResponse> {
  const sp = new URLSearchParams()
  if (params.type) sp.set('type', params.type)
  if (params.q) sp.set('q', params.q)
  for (const t of params.tags ?? []) sp.append('tags', t)
  if (params.limit !== undefined) sp.set('limit', String(params.limit))
  if (params.offset !== undefined) sp.set('offset', String(params.offset))
  const qs = sp.toString()
  return request<MemoryListResponse>('GET', `/memory/memories${qs ? `?${qs}` : ''}`)
}

/** One background job Hindsight is running against the bank — extracting
 *  facts from a just-retained turn, consolidating, refreshing a mental
 *  model. `status` is one of pending/running/done/failed as observed live;
 *  render an unrecognized value the same as "pending" rather than crashing. */
export interface MemoryOperation {
  id: string
  task_type: string
  items_count: number
  document_id?: string
  filename?: string
  created_at: string
  updated_at: string
  status: string
  error_message?: string
  retry_count: number
  next_retry_at?: string
  progress?: {
    stage: string
    at: string
    processed?: number
    total?: number
    detail?: Record<string, number>
  }
}

export interface MemoryOperationsResponse {
  bank_id: string
  total: number
  limit: number
  offset: number
  operations: MemoryOperation[]
}

export function fetchMemoryOperations(limit = 20): Promise<MemoryOperationsResponse> {
  return request<MemoryOperationsResponse>('GET', `/memory/operations?limit=${limit}`)
}

/** A graph node/edge as Hindsight returns it — genuinely untyped upstream
 *  (its OpenAPI schema declares both as bare objects with no fixed
 *  properties), so callers must read defensively across a few plausible
 *  field-name candidates rather than assume one. */
export type MemoryGraphElement = Record<string, unknown>

export interface MemoryGraphResponse {
  nodes: MemoryGraphElement[]
  edges: MemoryGraphElement[]
  total_units?: number
  total_entities?: number
  total_edges?: number
  limit?: number
}

export function fetchMemoryGraph(params: { type?: string; limit?: number; q?: string } = {}): Promise<MemoryGraphResponse> {
  const sp = new URLSearchParams()
  if (params.type) sp.set('type', params.type)
  if (params.limit !== undefined) sp.set('limit', String(params.limit))
  if (params.q) sp.set('q', params.q)
  const qs = sp.toString()
  return request<MemoryGraphResponse>('GET', `/memory/graph${qs ? `?${qs}` : ''}`)
}

export function fetchMemoryEntityGraph(params: { limit?: number; minCount?: number } = {}): Promise<MemoryGraphResponse> {
  const sp = new URLSearchParams()
  if (params.limit !== undefined) sp.set('limit', String(params.limit))
  if (params.minCount !== undefined) sp.set('min_count', String(params.minCount))
  const qs = sp.toString()
  return request<MemoryGraphResponse>('GET', `/memory/entities/graph${qs ? `?${qs}` : ''}`)
}

export interface MemoryTimeseriesBucket {
  time: string
  world: number
  experience: number
  observation: number
}

export interface MemoryTimeseriesResponse {
  bank_id: string
  period: string
  buckets: MemoryTimeseriesBucket[]
}

export function fetchMemoryTimeseries(period: '7d' | '30d' | '90d' = '30d'): Promise<MemoryTimeseriesResponse> {
  return request<MemoryTimeseriesResponse>('GET', `/memory/timeseries?period=${period}`)
}

export interface MemoryRecallResult {
  id: string
  text: string
  type?: string
  context?: string
  tags?: string[]
  entities?: string[]
  mentioned_at?: string
  document_id?: string
  scores?: { final: number; reranker?: number; semantic?: number; keyword?: number }
}

export function searchMemory(body: { query: string; budget?: string; maxTokens?: number; tags?: string[] }): Promise<{ results: MemoryRecallResult[] }> {
  return request('POST', '/memory/recall', body)
}

export function reflectMemory(body: { query: string; budget?: string; maxTokens?: number }): Promise<{ text: string }> {
  return request('POST', '/memory/reflect', body)
}

/** Store one operator preference in the cross-project "global" tier — the one
 *  kind of memory that auto-recall surfaces in every project's chats, not only
 *  the project it was learned in. See backend memory.RecallTags / RetainGlobal. */
export function addGlobalPreference(text: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('POST', '/memory/global', { text })
}

/** Downloads the configured bank's full content — facts, entities, causal
 *  links, chunks, and consolidated observations — as a transfer ZIP the
 *  operator can move to another machine or cloud. Bypasses `request()`: the
 *  response is a binary file, not the `{"error"}` JSON envelope. */
export async function exportMemoryBrain(): Promise<{ blob: Blob; filename: string }> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/memory/export`)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network request failed'
    throw new ApiError(message, 0)
  }
  if (!res.ok) {
    throw await toApiError(res)
  }
  const blob = await res.blob()
  const filename = parseContentDispositionFilename(res.headers.get('Content-Disposition'), 'brain.zip')
  return { blob, filename }
}

export type MemoryImportMode = 'merge' | 'replace'

/** What the Import Brain dialog shows after a successful import — mirrors
 *  backend service.ImportSummary. `raw` is Hindsight's own untyped
 *  result_metadata (e.g. imported/skipped document counts). */
export interface MemoryImportSummary {
  cleared: boolean
  raw?: Record<string, unknown>
}

/** Uploads a transfer ZIP produced by exportMemoryBrain into the configured
 *  bank. mode "merge" adds anything new and leaves existing documents
 *  untouched; "replace" wipes the bank's existing memory content first. */
export async function importMemoryBrain(file: File, mode: MemoryImportMode): Promise<MemoryImportSummary> {
  const form = new FormData()
  form.append('file', file)
  form.append('mode', mode)

  let res: Response
  try {
    res = await fetch(`${API_BASE}/memory/import`, { method: 'POST', body: form })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network request failed'
    throw new ApiError(message, 0)
  }
  if (!res.ok) {
    throw await toApiError(res)
  }
  return res.json() as Promise<MemoryImportSummary>
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

export function cloneProject(wsId: string, body: CloneProjectBody): Promise<Project> {
  return request<Project>('POST', `/workspaces/${wsId}/projects/clone`, body)
}

export function updateProject(id: string, patch: UpdateProjectBody): Promise<Project> {
  return request<Project>('PATCH', `/projects/${id}`, patch)
}

export function deleteProject(id: string): Promise<void> {
  return request<void>('DELETE', `/projects/${id}`)
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

export interface BrowserProxySession {
  token: string
}

/** Authenticated bootstrap for sandboxed Browser module requests. */
export function fetchBrowserProxySession(): Promise<BrowserProxySession> {
  return request<BrowserProxySession>('GET', '/browser/session')
}

/** URL loaded by the Browser module; the remote request is made by the Go server. */
export function browserProxyUrl(targetUrl: string, token?: string): string {
  const params = new URLSearchParams({ url: targetUrl })
  if (token) params.set('token', token)
  return `${API_BASE}/browser/proxy?${params.toString()}`
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
    throw await toApiError(res)
  }

  return res.json() as Promise<Attachment>
}

export function fetchAttachments(issueId: string): Promise<Attachment[]> {
  return request<Attachment[]>('GET', `/issues/${issueId}/attachments`)
}

export function deleteAttachment(id: string): Promise<void> {
  return request<void>('DELETE', `/attachments/${id}`)
}

// ---- Comments ----

export function fetchComments(issueId: string): Promise<IssueComment[]> {
  return request<IssueComment[]>('GET', `/issues/${issueId}/comments`)
}

export function createComment(issueId: string, body: CreateCommentBody): Promise<IssueComment> {
  return request<IssueComment>('POST', `/issues/${issueId}/comments`, body)
}

export function updateComment(id: string, patch: UpdateCommentBody): Promise<IssueComment> {
  return request<IssueComment>('PATCH', `/comments/${id}`, patch)
}

export function deleteComment(id: string): Promise<void> {
  return request<void>('DELETE', `/comments/${id}`)
}

// ---- Issue timeline (auto-recorded field-change events, read-only) ----

export function fetchIssueEvents(issueId: string): Promise<IssueEvent[]> {
  return request<IssueEvent[]>('GET', `/issues/${issueId}/events`)
}

// ---- Seed ----

export function seed(): Promise<Workspace[]> {
  return request<Workspace[]>('POST', '/seed')
}

// ---- Auth ----

export interface RegisterBody {
  email: string
  password: string
}

export interface LoginBody {
  email: string
  password: string
  /** Cloudflare Turnstile token; required when the server has Turnstile configured. */
  turnstileToken?: string
}

export interface TotpCodeBody {
  code: string
}

export interface TotpSetupResponse {
  otpauthUri: string
}

export interface TotpVerifySetupResponse {
  backupCodes: string[]
}

export interface LoginResponse {
  /** 'ok' when the server runs with --2fa=false and the session is already set. */
  status: 'totp_required' | 'ok'
}

export interface AuthConfig {
  totpRequired: boolean
  /** Non-empty when login requires a Cloudflare Turnstile challenge. */
  turnstileSiteKey: string
}

export function fetchAuthConfig(): Promise<AuthConfig> {
  return request<AuthConfig>('GET', '/auth/config')
}

export function register(body: RegisterBody): Promise<User> {
  return request<User>('POST', '/auth/register', body)
}

export function login(body: LoginBody): Promise<LoginResponse> {
  return request<LoginResponse>('POST', '/auth/login', body)
}

export function setupTotp(): Promise<TotpSetupResponse> {
  return request<TotpSetupResponse>('POST', '/auth/totp/setup')
}

export function verifyTotpSetup(body: TotpCodeBody): Promise<TotpVerifySetupResponse> {
  return request<TotpVerifySetupResponse>('POST', '/auth/totp/verify-setup', body)
}

export function verifyTotp(body: TotpCodeBody): Promise<User> {
  return request<User>('POST', '/auth/totp/verify', body)
}

export function logout(): Promise<void> {
  return request<void>('POST', '/auth/logout')
}

export function fetchMe(): Promise<User> {
  return request<User>('GET', '/auth/me')
}

/** GET /api/whoami — reports this process's role (hub vs. runtime). */
export function fetchWhoami(): Promise<Whoami> {
  return request<Whoami>('GET', '/whoami')
}

// ---- Runtime sign-in PIN ----
//
// A runtime's own web UI signs in with a 6-digit PIN rather than the runtime
// key: the key stays the machine-to-machine credential the hub proxies with,
// but nobody wants to type 64 hex characters on a phone. These routes only
// exist on a --role runtime process; on the hub they answer 404.

export interface PinStatus {
  configured: boolean
  length: number
}

/** POST /api/auth/pin-session — the runtime's entire browser sign-in. Rejects
 *  with 429 while the server-side lockout is in force. */
export function postPinSession(pin: string): Promise<void> {
  return request<void>('POST', '/auth/pin-session', { pin })
}

/** GET /api/auth/pin — whether a PIN is set. The PIN itself is stored as a
 *  bcrypt hash and can never be read back. */
export function fetchPinStatus(): Promise<PinStatus> {
  return request<PinStatus>('GET', '/auth/pin')
}

/** PUT /api/auth/pin — set or rotate this process's sign-in PIN. */
export function updatePin(pin: string): Promise<void> {
  return request<void>('PUT', '/auth/pin', { pin })
}

// ---- Tools ----

export interface MarkitdownResult {
  filename: string
  markdown: string
}

/** Converts an uploaded document (pdf/docx/pptx/xlsx/image/audio/html/...) to markdown via markitdown. */
export async function convertToMarkdown(file: File): Promise<MarkitdownResult> {
  const form = new FormData()
  form.append('file', file)

  let res: Response
  try {
    res = await fetch(`${API_BASE}/tools/markitdown`, { method: 'POST', body: form })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network request failed'
    throw new ApiError(message, 0)
  }

  if (!res.ok) {
    throw await toApiError(res)
  }

  return res.json() as Promise<MarkitdownResult>
}

export type MarkdownExportFormat = 'docx' | 'pdf'

/** Exports markdown (mermaid blocks rendered to images) to a docx/pdf Blob, ready for download. */
export async function exportMarkdown(
  markdown: string,
  format: MarkdownExportFormat,
  filename?: string,
): Promise<Blob> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/tools/markdown-export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown, format, filename }),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network request failed'
    throw new ApiError(message, 0)
  }

  if (!res.ok) {
    throw await toApiError(res)
  }

  return res.blob()
}

// ---- Machines (hub registry of runtime machines) ----

export interface CreateMachineBody {
  name: string
  url: string
  key: string
}

export interface UpdateMachineBody {
  name?: string
  url?: string
  key?: string
}

export interface MachineHealth {
  status: 'online' | 'offline'
  latencyMs?: number
}

export interface MachineVersion {
  version: string
  sha256: string
}

/** How much live work restarting a machine's runtime would destroy.
 *
 *  `terminals` is the PTY session count; `agentRuns` counts orchestration
 *  threads that are running or waiting on the operator. Both matter because
 *  DevDeck never reaps detached PTYs and an agent run needs no attached
 *  terminal — `activeSessions` on the update-check response sees only the
 *  former and therefore under-reports. See decision D3 of
 *  `docs/superpowers/specs/2026-08-24-desktop-auto-update-design.md`. */
export interface MachineBusy {
  terminals: number
  agentRuns: number
}

/** Result of a manual update check. `error` is non-empty when the check itself
 *  failed — the request still succeeds with 200 so one broken machine doesn't
 *  blank the page. */
export interface MachineUpdateCheck {
  current: string
  latest: string
  updateAvailable: boolean
  checksumVerified: 'match' | 'mismatch' | 'unknown'
  tokenConfigured: boolean
  activeSessions: number
  managed: boolean
  error: string
}

export interface MachineUpdateResult {
  status: 'updated' | 'up-to-date'
  version: string
  warning: string
}

export function fetchMachines(): Promise<Machine[]> {
  return request<Machine[]>('GET', '/machines')
}

export function createMachine(body: CreateMachineBody): Promise<Machine> {
  return request<Machine>('POST', '/machines', body)
}

export function updateMachine(id: string, patch: UpdateMachineBody): Promise<Machine> {
  return request<Machine>('PATCH', `/machines/${id}`, patch)
}

export function deleteMachine(id: string): Promise<void> {
  return request<void>('DELETE', `/machines/${id}`)
}

export function restartMachine(id: string): Promise<void> {
  return request<void>('POST', `/machines/${id}/restart`)
}

export function stopMachine(id: string): Promise<void> {
  return request<void>('POST', `/machines/${id}/stop`)
}

export function fetchMachineHealth(id: string): Promise<MachineHealth> {
  return request<MachineHealth>('GET', `/machines/${id}/health`)
}

export function fetchMachineVersion(id: string): Promise<MachineVersion> {
  return request<MachineVersion>('GET', `/machines/${id}/version`)
}

export function fetchMachineBusy(id: string): Promise<MachineBusy> {
  return request<MachineBusy>('GET', `/machines/${id}/busy`)
}

export function fetchMachineUpdateCheck(id: string): Promise<MachineUpdateCheck> {
  return request<MachineUpdateCheck>('GET', `/machines/${id}/update-check`)
}

/** Installs the latest release on a machine. Named to avoid colliding with
 *  `updateMachine`, which PATCHes a machine's name/url/key. */
export function installMachineUpdate(id: string): Promise<MachineUpdateResult> {
  return request<MachineUpdateResult>('POST', `/machines/${id}/update`)
}

/** Mints a 60-second hub-signed handover token scoped to one machine — see internal/handovertoken. */
export function mintHandoverToken(machineId: string): Promise<{ token: string }> {
  return request<{ token: string }>('POST', `/machines/${machineId}/token`)
}

// ---- Bookmarks (machine-proxied Browser tile's saved pages) ----

export interface CreateBookmarkBody {
  machineId?: string
  group?: string
  title: string
  url: string
}

export interface UpdateBookmarkBody {
  group?: string
  title?: string
}

export function fetchBookmarks(): Promise<Bookmark[]> {
  return request<Bookmark[]>('GET', '/bookmarks')
}

/** Saves a page, fetching its favicon server-side — see FaviconService.
 *  Re-saving the same machine+url updates that bookmark instead of creating a
 *  duplicate (see store.CreateBookmark), so this doubles as "refresh icon". */
export function createBookmark(body: CreateBookmarkBody): Promise<Bookmark> {
  return request<Bookmark>('POST', '/bookmarks', body)
}

export function updateBookmark(id: string, patch: UpdateBookmarkBody): Promise<Bookmark> {
  return request<Bookmark>('PATCH', `/bookmarks/${id}`, patch)
}

export function deleteBookmark(id: string): Promise<void> {
  return request<void>('DELETE', `/bookmarks/${id}`)
}

export interface TailscaleHubStatus {
  ready: boolean
  reason?: 'not_installed' | 'not_ready' | 'serve_disabled' | 'serve_target_mismatch'
  url?: string
}

export function fetchTailscaleStatus(): Promise<TailscaleHubStatus> {
  return request<TailscaleHubStatus>('GET', '/tailscale-status')
}

export interface HubKeyStatus {
  /** False when this hub was started without --key, which makes runtime
   *  self-registration impossible. */
  configured: boolean
  /** The hub's bearer key, or '' when not configured. */
  key: string
}

/** Fetches this hub's own bearer key so the Add-runtime dialog can build a
 *  copy-pasteable install command. Hub and `both` roles only — see
 *  backend/internal/handler/hubkey.go. */
export function fetchHubKey(): Promise<HubKeyStatus> {
  return request<HubKeyStatus>('GET', '/self/hub-key')
}

// ---- Published SOCKS5 on THIS process ----
//
// The machine registry only holds *remote* runtimes: a --role hub never
// self-registers (that path is gated on being a runtime with a hub URL), so
// the process serving this page is usually absent from its own list. These
// two hit /api/proxy/publish on the current origin — the route is registered
// on every role — so the operator can publish a proxy on the machine they are
// looking at. The per-machine equivalents (fetchPublishedSocks /
// setPublishedSocks in machineApi.ts) go through machineRequest instead.

/** Reads this process's own persistent SOCKS5 publication. */
export function fetchLocalPublishedSocks(): Promise<PublishedSOCKSStatus> {
  return request<PublishedSOCKSStatus>('GET', '/proxy/publish')
}

/** Applies publication state on this process and persists it. */
export function setLocalPublishedSocks(body: PublishedSOCKSRequest): Promise<PublishedSOCKSStatus> {
  return request<PublishedSOCKSStatus>('PUT', '/proxy/publish', body)
}

// ---- SSH connections (hub registry; secrets are write-only) ----

export interface CreateSSHConnectionBody {
  name: string
  group?: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privatekey'
  password?: string
  privateKey?: string
  privateKeyPath?: string
  passphrase?: string
  /** Chains this connection through another saved connection for bastion hops. */
  jumpConnectionId?: string | null
  /** Which Machine dials this host; null/omitted means the hub decides. */
  executorMachineId?: string | null
}

export type UpdateSSHConnectionBody = Partial<CreateSSHConnectionBody>

export function fetchSSHConnections(): Promise<SSHConnection[]> {
  return request<SSHConnection[]>('GET', '/ssh/connections')
}

export function createSSHConnection(body: CreateSSHConnectionBody): Promise<SSHConnection> {
  return request<SSHConnection>('POST', '/ssh/connections', body)
}

export function updateSSHConnection(id: string, patch: UpdateSSHConnectionBody): Promise<SSHConnection> {
  return request<SSHConnection>('PATCH', `/ssh/connections/${id}`, patch)
}

export function deleteSSHConnection(id: string): Promise<void> {
  return request<void>('DELETE', `/ssh/connections/${id}`)
}

/** Clears a pinned host key after a "host key changed" block, so the next
 *  connect re-pins whatever key the host presents. */
export function acceptSSHHostKey(id: string): Promise<void> {
  return request<void>('POST', `/ssh/connections/${id}/accept-hostkey`)
}

/** One live CPU/memory/disk sample from a saved SSH host. A hub route, not a
 *  machine route — the hub holds this connection's credentials. */
export function fetchSSHStats(connectionId: string): Promise<HostStats> {
  return request<HostStats>('GET', `/ssh/connections/${connectionId}/stats`)
}

// ---- SSH port-forwarding rules (hub-owned; the executor holds only live
// listeners, in memory — see backend/internal/sshmgr) ----

export function fetchSSHForwards(connectionId: string): Promise<SSHForward[]> {
  return request<SSHForward[]>('GET', `/ssh/connections/${connectionId}/forwards`)
}

export function createSSHForward(
  connectionId: string,
  body: Omit<SSHForward, 'id' | 'connectionId'>,
): Promise<SSHForward> {
  return request<SSHForward>('POST', `/ssh/connections/${connectionId}/forwards`, body)
}

export function updateSSHForward(
  id: string,
  body: Partial<Omit<SSHForward, 'id' | 'connectionId'>>,
): Promise<SSHForward> {
  return request<SSHForward>('PATCH', `/ssh/forwards/${id}`, body)
}

export function deleteSSHForward(id: string): Promise<void> {
  return request<void>('DELETE', `/ssh/forwards/${id}`)
}

/** Starts a forward by pushing the whole rule, not just its id: the
 *  Forwarder never re-reads a persisted copy between creating a rule and
 *  starting it, which is what keeps forwarding out of catalog sync. */
export function startSSHForward(rule: SSHForward): Promise<SSHForwardState> {
  return request<SSHForwardState>('POST', '/ssh/forwards/start', rule)
}

export function stopSSHForward(id: string): Promise<SSHForwardState> {
  return request<SSHForwardState>('POST', `/ssh/forwards/${id}/stop`)
}

export function fetchSSHForwardStates(): Promise<SSHForwardState[]> {
  return request<SSHForwardState[]>('GET', '/ssh/forwards/states')
}

// ---- DB connections (hub registry; secrets are write-only) ----

export interface DBCaps {
  schemas: boolean
  matViews: boolean
  functions: boolean
  multiDatabase: boolean
  rowIdentifier: string
  sizeStats: boolean
  quoteChar: string
  /** Statement prefix that renders a query plan for this engine, without a
   *  trailing space ("EXPLAIN", "EXPLAIN QUERY PLAN"). */
  explainPrefix: string
}

export interface CreateDBConnectionBody {
  name: string
  group?: string
  engine: DBEngine
  host?: string
  port?: number
  username?: string
  database?: string
  sslMode?: string
  executorMachineId?: string | null
  tunnelConnectionId?: string | null
  isProduction?: boolean
  password?: string
  caCert?: string
  clientCert?: string
  clientKey?: string
}

export type UpdateDBConnectionBody = Partial<CreateDBConnectionBody>

export interface DBTestResult {
  ok: boolean
  reason?: string
}

export function fetchDBConnections(): Promise<DBConnection[]> {
  return request<DBConnection[]>('GET', '/db/connections')
}

export function createDBConnection(body: CreateDBConnectionBody): Promise<DBConnection> {
  return request<DBConnection>('POST', '/db/connections', body)
}

export function updateDBConnection(id: string, patch: UpdateDBConnectionBody): Promise<DBConnection> {
  return request<DBConnection>('PATCH', `/db/connections/${id}`, patch)
}

export function deleteDBConnection(id: string): Promise<void> {
  return request<void>('DELETE', `/db/connections/${id}`)
}

/** kind is one of "password" | "ca_cert" | "client_cert" | "client_key"; an
 *  empty value clears the stored credential rather than storing an empty one. */
export function setDBSecret(id: string, kind: string, value: string): Promise<void> {
  return request<void>('POST', `/db/connections/${id}/secret`, { kind, value })
}

/** Always resolves — a connection that cannot be reached is data
 *  ({ok:false, reason}), not a thrown ApiError. */
export function testDBConnection(id: string): Promise<DBTestResult> {
  return request<DBTestResult>('POST', `/db/connections/${id}/test`)
}

export function fetchDBEngines(): Promise<Record<DBEngine, DBCaps>> {
  return request<Record<DBEngine, DBCaps>>('GET', '/db/engines')
}

export function fetchDBSavedQueries(connectionId: string): Promise<DBSavedQuery[]> {
  return request<DBSavedQuery[]>('GET', `/db/connections/${connectionId}/queries`)
}

export function createDBSavedQuery(connectionId: string, name: string, sql: string): Promise<DBSavedQuery> {
  return request<DBSavedQuery>('POST', `/db/connections/${connectionId}/queries`, { name, sql })
}

export function updateDBSavedQuery(id: string, patch: { name?: string; sql?: string }): Promise<DBSavedQuery> {
  return request<DBSavedQuery>('PATCH', `/db/queries/${id}`, patch)
}

export function deleteDBSavedQuery(id: string): Promise<void> {
  return request<void>('DELETE', `/db/queries/${id}`)
}

// ---- DB query history (SQL editor executions, newest first) ----

/** Newest first. The server clamps `limit` rather than rejecting it, and
 *  defaults to 50 when it is omitted. */
export function fetchDBQueryHistory(connectionId: string, limit?: number): Promise<DBQueryHistoryEntry[]> {
  const qs = limit === undefined ? '' : `?limit=${limit}`
  return request<DBQueryHistoryEntry[]>('GET', `/db/connections/${connectionId}/history${qs}`)
}

export function clearDBQueryHistory(connectionId: string): Promise<void> {
  return request<void>('DELETE', `/db/connections/${connectionId}/history`)
}

// ---- DB tree / metadata (read path) ----

export interface DBObjectRef {
  database: string
  schema: string
  name: string
  kind: string // "table" | "view" | "matview" | "function"
}

export interface DBTreePath {
  database: string
  schema: string
  kind: string // "" | "databases" | "schemas" | "tables" | "views" | "matviews" | "functions"
}

export interface DBTreeNode {
  name: string
  kind: string
  hasChildren: boolean
}

export interface DBColumnMeta {
  name: string
  dataType: string
  nullable: boolean
  default: string | null
  isPrimaryKey: boolean
  ordinalPosition: number
  isLob: boolean
  comparable: boolean
}

export interface DBIndexMeta {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  nullable: boolean
}

export interface DBTableStats {
  estRows: number | null
  totalBytes: number | null
  indexBytes: number | null
  analyzed: boolean
}

export function fetchDBTree(connectionId: string, path: DBTreePath): Promise<DBTreeNode[]> {
  return request<DBTreeNode[]>('POST', `/db/connections/${connectionId}/tree`, path)
}

export function fetchDBColumns(connectionId: string, object: DBObjectRef): Promise<DBColumnMeta[]> {
  return request<DBColumnMeta[]>('POST', `/db/connections/${connectionId}/columns`, { object })
}

export function fetchDBIndexes(connectionId: string, object: DBObjectRef): Promise<DBIndexMeta[]> {
  return request<DBIndexMeta[]>('POST', `/db/connections/${connectionId}/indexes`, { object })
}

export function fetchDBStats(connectionId: string, object: DBObjectRef): Promise<DBTableStats> {
  return request<DBTableStats>('POST', `/db/connections/${connectionId}/stats`, { object })
}

// ---- DB rows (read path) ----

export interface DBFilter {
  column: string
  op: string // eq ne lt gt le ge between in isnull isnotnull like ilike
  values: unknown[]
}

export interface DBSortKey {
  column: string
  desc: boolean
}

export interface DBRowsRequest {
  object: DBObjectRef
  filters: DBFilter[]
  sort: DBSortKey[]
  cursor: unknown[] | null
  offset: number
  limit: number
  globalSearch: string
}

export interface DBResultSet {
  columns: DBColumnMeta[]
  rows: unknown[][]
  truncated: boolean
  nextCursor: unknown[] | null
  usedOffsetPaging: boolean
  elapsedMs: number
}

export function fetchDBRows(connectionId: string, req: DBRowsRequest): Promise<DBResultSet> {
  return request<DBResultSet>('POST', `/db/connections/${connectionId}/rows`, req)
}

/** Exact COUNT(*) — an explicit user action only, never fetched on the read
 *  path (the estimate in DBTableStats covers that). Respects the same
 *  filters as the current grid view. */
export function fetchDBCount(connectionId: string, object: DBObjectRef, filters: DBFilter[]): Promise<{ count: number }> {
  return request<{ count: number }>('POST', `/db/connections/${connectionId}/count`, { object, filters })
}

export function fetchDBQuery(connectionId: string, sql: string): Promise<DBResultSet> {
  return request<DBResultSet>('POST', `/db/connections/${connectionId}/query`, { sql, args: [] })
}

// ---- DB rows (write path) ----

export interface DBRowEdit {
  object: DBObjectRef
  kind: 'insert' | 'update' | 'delete'
  oldValues?: Record<string, unknown>
  newValues?: Record<string, unknown>
  rowPointer?: unknown
}

export interface DBExecResult {
  rowsAffected: number
  elapsedMs: number
}

export interface DBCommitResult {
  results: DBExecResult[]
  elapsedMs: number
}

export function commitDBEdits(connectionId: string, edits: DBRowEdit[]): Promise<DBCommitResult> {
  return request<DBCommitResult>('POST', `/db/connections/${connectionId}/commit`, { edits })
}

// ---- DB DDL (table/index create/alter, generated DDL) ----

export interface DBColumnPlan {
  name: string
  dataType: string
  nullable: boolean
  default: string | null
  isPrimaryKey: boolean
}

export interface DBIndexPlan {
  name: string
  columns: string[]
  unique: boolean
}

export interface DBTablePlan {
  object: DBObjectRef
  kind: 'create' | 'alter' | 'drop'
  columns?: DBColumnPlan[]
  indexes?: DBIndexPlan[]
}

export function fetchDBDDLPreview(connectionId: string, plan: DBTablePlan): Promise<{ statements: string[] }> {
  return request<{ statements: string[] }>('POST', `/db/connections/${connectionId}/ddl/preview`, { plan })
}

export function applyDBDDL(connectionId: string, plan: DBTablePlan): Promise<DBCommitResult> {
  return request<DBCommitResult>('POST', `/db/connections/${connectionId}/ddl/apply`, { plan })
}

export function fetchDBShowCreate(connectionId: string, object: DBObjectRef): Promise<{ ddl: string }> {
  return request<{ ddl: string }>('POST', `/db/connections/${connectionId}/show-create`, { object })
}

// ---- DB export (streaming; the one DB endpoint that is not JSON) ----

export type DBExportFormat = 'csv' | 'json' | 'sql'

export interface DBExportRequest {
  object: DBObjectRef
  filters: DBFilter[]
  sort: DBSortKey[]
  format: DBExportFormat
  /** 0/omitted means "up to the server cap" (1,000,000 rows). */
  limit?: number
}

/** Downloads a table export as a Blob plus the server's suggested filename.
 *
 *  Deliberately not built on `request()`: that helper parses every response as
 *  JSON, and this endpoint streams a csv/json/sql file that may be hundreds of
 *  megabytes. Only the failure path is JSON — the server fetches its first
 *  page and runs the encoder's preamble *before* writing any byte, so a
 *  rejected identifier or an unreachable database still arrives as the normal
 *  `{"error":...}` envelope with the status intact. That is why the non-OK
 *  branch below can reuse `toApiError` unchanged, and why a caller can catch
 *  `ApiError` here exactly as it would from `request()`.
 *
 *  A failure *after* the first byte cannot be an envelope (the status line is
 *  already committed); the server aborts the connection instead, which
 *  surfaces here as the fetch/stream rejecting — an ApiError with status 0,
 *  same as any other network fault.
 */
export async function exportDBTable(
  connectionId: string,
  body: DBExportRequest,
): Promise<{ blob: Blob; filename: string }> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}/db/connections/${connectionId}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network request failed'
    throw new ApiError(message, 0)
  }

  if (!res.ok) {
    throw await toApiError(res)
  }

  let blob: Blob
  try {
    blob = await res.blob()
  } catch (err) {
    // The server aborted mid-stream (see the doc comment) — a partial file is
    // worse than a visible failure, so this never resolves with what arrived.
    const message = err instanceof Error ? err.message : 'Export stream failed'
    throw new ApiError(message, 0)
  }

  const fallback = `${body.object.name || 'export'}.${body.format}`
  const filename = parseContentDispositionFilename(res.headers.get('Content-Disposition'), fallback)
  return { blob, filename }
}

// Domain model for loom — mirrors the Loom v2 mockup's data shapes.

export type WorktreeState = 'running' | 'waiting' | 'idle' | 'stopped' | 'error'
export type Priority = 'high' | 'normal' | 'low'
export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue'
export type IssueStatus = 'todo' | 'in_progress' | 'in_review' | 'done'

/** Kinds of terminal-log lines, each mapped to a color in constants.ts. */
export type LineKind = 'cmd' | 'out' | 'ok' | 'warn' | 'err' | 'sys' | 'file' | 'dim'

export interface TermLine {
  k: LineKind
  t: string
}

export interface Worktree {
  id: string
  /** A root-terminal session has no branch (runs in the project root). */
  root?: boolean
  branch: string
  base: string
  ahead: number
  behind: number
  model: string
  agent: string
  state: WorktreeState
  task: string
  tokens: number
  /** seconds */
  elapsed: number
  added: number
  removed: number
  files: number
  /** Simulated agent-output tail used for card previews. */
  lines: TermLine[]
  /** Pending approval prompt, when state === 'waiting'. */
  pending: string | null
}

export interface Issue {
  id: string
  title: string
  description: string
  status: IssueStatus
  priority: Priority
  assignee: string | null
  position: number
  createdAt: string
  updatedAt: string
}

export interface Project {
  id: string
  name: string
  repo: string
  path: string
  expanded: boolean
  /** Registered runtime machine this project runs on; empty = local/unassigned. */
  machineId: string
  worktrees: Worktree[]
  issues: Issue[]
}

/** A file uploaded from an issue's description editor. Fetch its bytes via
 *  GET /api/attachments/{id} — see `attachmentUrl()` in lib/api.ts. */
export interface Attachment {
  id: string
  issueId: string
  filename: string
  mimeType: string
  size: number
  createdAt: string
}

/** A comment on an issue's Activity timeline, or — when parentId is set — a
 *  single-level-deep reply to another comment. */
export interface IssueComment {
  id: string
  issueId: string
  parentId: string | null
  author: string
  body: string
  createdAt: string
  updatedAt: string
}

export type IssueEventKind = 'status_changed' | 'priority_changed' | 'assignee_changed'

/** A single Activity timeline entry, auto-recorded when an issue's status,
 *  priority, or assignee changes. Read-only — there's no author input. */
export interface IssueEvent {
  id: string
  issueId: string
  kind: IssueEventKind
  fromValue: string | null
  toValue: string | null
  createdAt: string
}

export interface NewsItem {
  id: string
  source: string
  title: string
  tag: string
  time: string
  unread: boolean
}

export interface Todo {
  id: string
  text: string
  done: boolean
  priority: Priority
}

export interface BankDetail {
  bankName: string
  accountName: string
  accountNumber: string
}

export interface Company {
  id: string
  name: string
  shortAddress: string
}

export interface Bank {
  id: string
  bankName: string
  accountName: string
  accountNumber: string
}

/** A registered runtime machine (hub registry). */
export interface Machine {
  id: string
  name: string
  url: string
  key: string
  /** True only for the Tauri desktop shell's self-registered embedded runtime. */
  isLocal: boolean
}

export interface InvoiceItem {
  description: string
  quantity: number
  unitPrice: number
}

export interface Invoice {
  id: string
  number: string
  companyName: string
  companyAddress: string
  items: InvoiceItem[]
  amount: number
  status: InvoiceStatus
  /** ISO date (YYYY-MM-DD), server-assigned on creation. */
  createdAt: string
  /** ISO date (YYYY-MM-DD). */
  dueDate: string
  bankDetail: BankDetail
}

export interface RecurringInvoiceTemplate {
  id: string
  companyName: string
  companyAddress: string
  items: InvoiceItem[]
  bankDetail: BankDetail
  dayOfMonth: number
  paymentTermDays: number
  active: boolean
  lastGeneratedYm: string
  createdAt: string
}

export interface Workspace {
  id: string
  name: string
  projects: Project[]
  news: NewsItem[]
  todos: Todo[]
  invoices: Invoice[]
  recurringTemplates: RecurringInvoiceTemplate[]
}

export type ModuleView = 'agents' | 'management' | 'news' | 'todos' | 'invoices' | 'tools' | 'browser' | 'machines'

// Agent types — fetched dynamically from the backend.
export interface AgentSummary {
  id: string
  name: string
  description: string
  icon: string
  installed: boolean
  modelCount: number
  skillCount: number
}

export interface AgentModel {
  id: string
  name: string
  contextWindow: number
}

export interface AgentSkill {
  name: string
  description: string
  category: string
  readOnly: boolean
}

export interface MCPServer {
  name: string
  agentId: string
  transport: 'stdio' | 'http' | string
  target: string
  argCount: number
  envKeys: string[]
  enabled: boolean
  status: string
}

export interface Agent {
  id: string
  name: string
  description: string
  icon: string
  installed: boolean
  models: AgentModel[]
  skills: AgentSkill[]
}

/**
 * Redacted view of a Claude Code LLM-environment profile (the `env` block of
 * ~/.claude/settings.json). The auth token is never sent to the client — only
 * HasToken. Models maps the alias slot (opus/sonnet/haiku) to a model id.
 */
export interface EnvProfileSummary {
  id: string
  agentId: string
  name: string
  baseUrl: string
  hasToken: boolean
  models: Record<string, string>
  extraEnv: Record<string, string>

  // Codex-specific (ignored for Claude)
  codexProviderName?: string
  codexWireAPI?: string
  codexEnvKey?: string
  codexContextWindow?: number
  codexMaxTokens?: number

  active: boolean
  updatedAt: string
}

/** A single model id advertised by a provider's model catalog. */
export interface EnvModelOption {
  id: string
}

export interface Settings {
  activeWorkspaceId: string | null
  defaultModel: string
}

/** A single directory entry returned by GET /api/fs/list. */
export interface FsEntry {
  name: string
  isDir: boolean
  git: boolean
}

/** The single Loom operator account. Never carries a password or TOTP secret. */
export interface User {
  id: string
  email: string
  totpEnabled: boolean
  createdAt: string
}

// Domain model for loom — mirrors the Loom v2 mockup's data shapes.

export type WorktreeState = 'running' | 'waiting' | 'idle' | 'stopped' | 'error'
export type Priority = 'high' | 'normal' | 'low'
export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue'

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

export interface Project {
  id: string
  name: string
  repo: string
  path: string
  expanded: boolean
  worktrees: Worktree[]
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

export interface Workspace {
  id: string
  name: string
  projects: Project[]
  news: NewsItem[]
  todos: Todo[]
  invoices: Invoice[]
}

export type ModuleView = 'agents' | 'news' | 'todos' | 'invoices'

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

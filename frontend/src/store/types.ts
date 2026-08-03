// Domain model for devdeck — mirrors the DevDeck v2 mockup's data shapes.

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
  /** Owning workspace. Populated by machine-scoped reads (e.g. CatalogSnapshot);
   *  unset when nested inside a Workspace's own `projects` list, where the
   *  parent is already implied. */
  workspaceId: string
  worktrees: Worktree[]
  issues: Issue[]
  /** "hub" (synced) or "local" (created on this runtime, not yet replayed). Only meaningful on a runtime. */
  origin: string
  /** Set when this runtime's last replay attempt failed permanently (e.g. its workspace no longer exists on the hub). */
  syncError?: string
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
  /** The hub's Ed25519 public key (base64) — the same value on every machine; unused by the UI, present only to mirror the backend type. */
  signingPublicKey: string
}

/** A saved page in the machine-proxied Browser tile. Server-side (not
 *  localStorage) so the same bookmarks show up whether you're on the desktop
 *  app or a phone hitting the same hub — see backend/internal/domain.Bookmark. */
export interface Bookmark {
  id: string
  /** Empty string means unassigned; groups under "Unassigned" in the UI. */
  machineId: string
  group: string
  title: string
  url: string
  /** `data:image/…;base64,…`, or empty when no icon could be fetched. */
  iconDataUrl: string
}

/** A saved SSH connection (operator-global registry — mirrors the backend's
 *  domain.SSHConnection). Secrets are write-only: they ride on create/update
 *  requests and never serialize back, unlike Machine.key which clients need
 *  for direct-first connections. */
export interface SSHConnection {
  id: string
  name: string
  group: string
  host: string
  port: number
  username: string
  authType: 'password' | 'privatekey'
  jumpConnectionId: string | null
  executorMachineId: string | null
  hostKeyFingerprint: string | null
}

export type DBEngine = 'postgres' | 'mysql' | 'sqlite'

/** Mirrors backend domain.DBConnection. Secrets are write-only: they ride on
 *  create/update bodies and never come back in a response. */
export interface DBConnection {
  id: string
  name: string
  group: string
  engine: DBEngine
  host: string
  port: number
  username: string
  database: string
  sslMode: string
  executorMachineId: string | null
  tunnelConnectionId: string | null
  isProduction: boolean
  serverCertFingerprint: string | null
}

/** Mirrors backend domain.DBSavedQuery. */
export interface DBSavedQuery {
  id: string
  connectionId: string
  name: string
  sql: string
  updatedAt: string
}

/** Mirrors backend domain.DBQueryHistoryEntry — one recorded SQL editor
 *  execution. Failures are recorded alongside successes; `error` carries the
 *  already-redacted message the client received (never a raw driver error)
 *  and is the empty string for a success. */
export interface DBQueryHistoryEntry {
  id: string
  connectionId: string
  sql: string
  status: 'success' | 'error'
  error: string
  elapsedMs: number
  rowCount: number
  executedAt: string
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

/** One runtime's slice of the hub's catalog: every workspace (they are the
 *  grouping), but only the projects and SSH connections bound to that
 *  machine. Rows for other machines are never included — not merely hidden. */
export interface CatalogSnapshot {
  workspaces: Workspace[]
  projects: Project[]
  sshConnections: SSHConnection[]
}

export type ModuleView = 'agents' | 'management' | 'news' | 'todos' | 'invoices' | 'tools' | 'browser' | 'machines' | 'ssh' | 'database'

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

/** The single DevDeck operator account. Never carries a password or TOTP secret. */
export interface User {
  id: string
  email: string
  totpEnabled: boolean
  createdAt: string
}

/** GET /api/whoami — an authenticated liveness probe that also reports this
 * process's role, so the SPA can tell a hub apart from a runtime. */
export interface Whoami {
  status: string
  role: 'hub' | 'runtime'
  machineName: string
  /** RFC3339 timestamp of the last clean catalog snapshot, or null if never. */
  lastSyncedAt: string | null
  /** This runtime's configured --hub-url, empty on the hub. */
  hubUrl: string
  /** This runtime's own hub-assigned machine id, empty until self-registration first succeeds. */
  machineId: string
}

/** Purely frontend UI state — no backend counterpart, so the CONTRACTS.md
 *  domain-type-mirroring rule doesn't apply here. Lives in `types.ts` rather
 *  than colocated in `useDevDeckStore.ts` (like `BrowserDocState`) because
 *  every occlusion-aware component (7+ files across `components/ui/` and
 *  `features/browser/`) needs to import just the type, not the store's own
 *  runtime logic. */
export interface OverlayBlockerRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** A blocker's on-screen footprint. `'viewport'` is a first-class region —
 *  not a special-cased rect — meaning "covers the whole app": a modal
 *  backdrop, the mobile sidebar drawer. Anything smaller reports its own
 *  `OverlayBlockerRect` instead. See `useNativeOverlayBlocker.ts`. */
export type OverlayBlockerRegion = OverlayBlockerRect | 'viewport'

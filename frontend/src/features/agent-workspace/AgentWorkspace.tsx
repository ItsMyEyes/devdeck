import { Component, lazy, Suspense, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  Activity,
  ArrowUpRight,
  Box,
  ChevronDown,
  Clock3,
  GitBranch,
  Layers3,
  List,
  Maximize2,
  Plus,
  RefreshCw,
  Users,
  X,
} from 'lucide-react'
import { SideDrawer } from '@/components/ui/drawer'
import { DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { useOfficeOverview } from '@/features/agent-workspace/useOfficeOverview'
import {
  isActive,
  needsAttention,
  statusColor,
  statusLabel,
  visibleSessions,
} from '@/features/agent-workspace/model'
import type { OfficeMember } from '@/features/agent-workspace/model'
import { sshMentionSource } from '@/features/agent-chat/composerMention'
import type { Workspace } from '@/store/types'
import '@/features/agent-workspace/office.css'

const OfficeScene = lazy(() => import('@/features/agent-workspace/OfficeScene'))
const AgentChatPane = lazy(() =>
  import('@/features/agent-chat/AgentChatPane').then((m) => ({
    default: m.AgentChatPane,
  })),
)
const SSHAgentChatPanel = lazy(() =>
  import('@/features/ssh/SSHAgentChatPanel').then((m) => ({
    default: m.SSHAgentChatPanel,
  })),
)
const LOCAL_MACHINE = {
  id: '',
  name: 'This server',
  url: '',
  key: '',
  isLocal: false,
  signingPublicKey: '',
}

class SceneBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? (
      <div className="office-empty">
        <Box size={32} />
        <h2>3D view unavailable</h2>
        <p>Your agents are still available in the session list.</p>
      </div>
    ) : (
      this.props.children
    )
  }
}

export function AgentWorkspace({ workspace }: { workspace: Workspace }) {
  const data = useOfficeOverview(workspace)
  const navigate = useNavigate()
  const openSpawn = useDevDeckStore((s) => s.openSpawn)
  const openWorktreeTab = useDevDeckStore((s) => s.openWorktreeTab)
  const [projectFilter, setProjectFilter] = useState('all')
  const [agentFilter, setAgentFilter] = useState('all')
  const [history, setHistory] = useState(false)
  const [selection, setSelection] = useState<{
    key: string
    child?: string
  } | null>(null)
  const [panel, setPanel] = useState<'activity' | 'sessions' | null>(null)
  const [flat, setFlat] = useState(false)
  const [cameraReset, setCameraReset] = useState(0)
  const selected = data.members.find((m) => m.key === selection?.key)
  const mentionSource = useMemo(
    () =>
      selected?.connectionId
        ? sshMentionSource(selected.connectionId)
        : undefined,
    [selected?.connectionId],
  )
  const projects = workspace.projects
  const filtered = data.members.filter(
    (m) =>
      (projectFilter === 'all' ||
        (projectFilter === 'shared-ssh'
          ? !!m.connectionId
          : m.projectId === projectFilter)) &&
      (agentFilter === 'all' || m.key === agentFilter),
  )
  const displayed = visibleSessions(filtered, history)
  const allVisible = displayed.length
    ? displayed
    : visibleSessions(
        filtered.filter((m) => m.limited),
        true,
      )
  if (
    selected &&
    filtered.some((m) => m.key === selected.key) &&
    !allVisible.some((m) => m.key === selected.key)
  )
    allVisible.push(selected)
  const admitted = visibleSessions(data.members, true)
  if (selected && !admitted.some((m) => m.key === selected.key))
    admitted.push(selected)
  const activity = useMemo(
    () =>
      filtered
        .flatMap((m) => m.recent.map((e) => ({ ...e, member: m })))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 50),
    [filtered],
  )
  const running = data.members.filter(
    (m) => !m.stale && m.status === 'running',
  ).length
  const waiting = data.members.filter((m) => needsAttention(m)).length
  const offline = data.sources.filter((s) => s.error).length
  const choose = (member: OfficeMember, child?: string) => {
    setSelection({ key: member.key, child })
    if (!isActive(member)) setHistory(true)
    setPanel(null)
  }
  function openWorktree(member: { projectId?: string; worktreeId?: string }) {
    if (!member.projectId || !member.worktreeId) return
    openWorktreeTab(workspace.id, member.projectId, member.worktreeId)
    void navigate({
      to: '/w/$wsId/p/$projectId/wt/$wtId',
      params: {
        wsId: workspace.id,
        projectId: member.projectId,
        wtId: member.worktreeId,
      },
    })
  }
  function openModule(module: string) {
    const paths = {
      todos: '/w/$wsId/todos',
      memory: '/w/$wsId/memory',
      machines: '/w/$wsId/machines',
      ssh: '/w/$wsId/ssh',
      tools: '/w/$wsId/tools',
      browser: '/w/$wsId/browser',
      database: '/w/$wsId/database',
      news: '/w/$wsId/news',
      invoices: '/w/$wsId/invoices',
      management: '/w/$wsId/management',
    } as const
    if (module === 'issues') {
      const p = projects.find((p) => p.id === projectFilter) ?? projects[0]
      if (p)
        void navigate({
          to: '/w/$wsId/p/$projectId/issues',
          params: { wsId: workspace.id, projectId: p.id },
        })
    } else if (module in paths)
      void navigate({
        to: paths[module as keyof typeof paths],
        params: { wsId: workspace.id },
      })
  }
  const sessionList = (
    <>
      <div className="office-panel-title">
        <Users size={15} />
        <h2>Sessions</h2>
        <span>{filtered.length}</span>
      </div>
      <div className="office-roster">
        {filtered
          .filter((m) => isActive(m) || m.limited)
          .sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)))
          .map((m) => (
            <SessionRow
              key={m.key}
              member={m}
              selected={selected?.key === m.key}
              onSelect={choose}
            />
          ))}
        {!data.loading && !filtered.some((m) => isActive(m) || m.limited) && (
          <p className="office-note">
            No active sessions. Start an agent or open recent sessions below.
          </p>
        )}
        <details
          onToggle={(e) => setHistory(e.currentTarget.open)}
          open={history}
          className="office-history"
        >
          <summary>
            <Clock3 size={13} /> Recent & idle{' '}
            <span>
              {filtered.filter((m) => !isActive(m) && !m.limited).length}
            </span>
            <ChevronDown size={12} />
          </summary>
          {filtered
            .filter((m) => !isActive(m) && !m.limited)
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((m) => (
              <SessionRow
                key={m.key}
                member={m}
                selected={selected?.key === m.key}
                onSelect={choose}
              />
            ))}
        </details>
      </div>
      <details className="office-history">
        <summary>Terminals without chat</summary>
        {projects.flatMap((p) =>
          p.worktrees
            .filter((w) => !data.members.some((m) => m.worktreeId === w.id))
            .map((w) => (
              <button
                className="office-member-main"
                key={w.id}
                onClick={() =>
                  openWorktree({ projectId: p.id, worktreeId: w.id })
                }
              >
                <GitBranch size={14} />
                <span>
                  <strong>
                    {p.name} · {w.branch || 'Root terminal'}
                  </strong>
                  <small>Process: {w.state} · AI activity unavailable</small>
                </span>
                <ArrowUpRight size={12} />
              </button>
            )),
        )}
      </details>
      <div className="office-panel-title">
        <Layers3 size={14} />
        <h2>Workspace</h2>
      </div>
      <div className="office-modules">
        <button
          disabled={!projects.length}
          onClick={() => openModule('issues')}
        >
          Issue board{' '}
          <span>
            {projects.reduce(
              (n, p) => n + p.issues.filter((i) => i.status !== 'done').length,
              0,
            )}{' '}
            open
          </span>
        </button>
        <button onClick={() => openModule('todos')}>
          Todos{' '}
          <span>{workspace.todos.filter((t) => !t.done).length} remaining</span>
        </button>
        <details>
          <summary>
            Open work items <ChevronDown size={12} />
          </summary>
          {projects
            .filter((p) => projectFilter === 'all' || p.id === projectFilter)
            .flatMap((p) =>
              p.issues
                .filter((i) => i.status !== 'done')
                .slice(0, 5)
                .map((i) => (
                  <button
                    key={i.id}
                    onClick={() =>
                      void navigate({
                        to: '/w/$wsId/p/$projectId/issues/$issueId',
                        params: {
                          wsId: workspace.id,
                          projectId: p.id,
                          issueId: i.id,
                        },
                      })
                    }
                  >
                    {i.title}
                    <span>{p.name}</span>
                  </button>
                )),
            )}
          {workspace.todos
            .filter((t) => !t.done)
            .slice(0, 5)
            .map((t) => (
              <button
                key={t.id}
                onClick={() =>
                  void navigate({
                    to: '/w/$wsId/todos',
                    params: { wsId: workspace.id },
                    hash: `todo-${t.id}`,
                  })
                }
              >
                {t.text}
                <span>Todo</span>
              </button>
            ))}
          {!projects.some((p) => p.issues.some((i) => i.status !== 'done')) &&
            !workspace.todos.some((t) => !t.done) && (
              <p className="office-note">No open work items.</p>
            )}
        </details>
        <button onClick={() => openModule('memory')}>
          Memory <ArrowUpRight size={13} />
        </button>
        <button onClick={() => openModule('machines')}>
          Runtimes <ArrowUpRight size={13} />
        </button>
        <button onClick={() => openModule('ssh')}>
          Shared SSH <ArrowUpRight size={13} />
        </button>
        <button onClick={() => openModule('tools')}>
          Tools & documents <ArrowUpRight size={13} />
        </button>
        <details>
          <summary>
            More modules <ChevronDown size={12} />
          </summary>
          {(
            ['browser', 'database', 'news', 'invoices', 'management'] as const
          ).map((key) => (
            <button key={key} onClick={() => openModule(key)}>
              {key[0].toUpperCase() + key.slice(1)}
              <ArrowUpRight size={13} />
            </button>
          ))}
        </details>
      </div>
    </>
  )
  const activityPanel = (
    <>
      <div className="office-panel-title">
        <Activity size={15} />
        <h2>Live activity</h2>
        <span className="office-live-dot" />
      </div>
      <div className="office-feed">
        {activity.map((e) => (
          <button
            key={`${e.member.key}:${e.id}`}
            onClick={() => choose(e.member, e.agentId)}
            className="office-event"
          >
            <span
              className="office-avatar-dot"
              style={{ background: statusColor(e.member.status) }}
            >
              {(e.member.agent || 'A')[0].toUpperCase()}
            </span>
            <span>
              <strong>{e.member.title || 'Untitled session'}</strong>
              <span>{e.text}</span>
              <time>
                {new Date(e.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}{' '}
                · {e.member.agent || 'Agent'}
              </time>
            </span>
          </button>
        ))}
        {!activity.length && (
          <p className="office-note">
            {data.loading
              ? 'Connecting to your agents…'
              : 'Activity appears here when agents work. Select a session to view its conversation.'}
          </p>
        )}
      </div>
      <div className="office-source-list">
        {data.sources.map((s) => (
          <div key={s.id}>
            <span
              className={`office-source-dot ${s.error ? 'is-offline' : ''}`}
            />
            <span>
              {s.name}
              <small>
                {s.loading
                  ? 'Connecting…'
                  : s.error
                    ? 'Unreachable · last known state'
                    : s.limited
                      ? 'Limited status · update runtime'
                      : s.sampledAt
                        ? `Updated ${new Date(s.sampledAt).toLocaleTimeString()}`
                        : 'No data'}
              </small>
            </span>
          </div>
        ))}
      </div>
    </>
  )
  const selectedProject = projects.find((p) => p.id === selected?.projectId)
  const selectedWorktree = selectedProject?.worktrees.find(
    (w) => w.id === selected?.worktreeId,
  )
  const child = selected?.subagents.find((c) => c.id === selection?.child)
  return (
    <main className="agent-office" aria-label="Agent Workspace 3D">
      <header className="office-header">
        <div className="office-brand">
          <span className="office-brand-icon">
            <Box size={21} />
          </span>
          <div>
            <h1>
              Agent Workspace <span>3D</span>
            </h1>
            <p>
              {workspace.name} <span> / </span> {projects.length} projects
            </p>
          </div>
        </div>
        <div className="office-stats">
          <div>
            <span>Working</span>
            <strong>{running}</strong>
          </div>
          <div>
            <span>Need attention</span>
            <strong>{waiting}</strong>
          </div>
          <div>
            <span>Unreachable</span>
            <strong>{offline}</strong>
          </div>
        </div>
        <button
          className="office-button office-new"
          disabled={!projects.length}
          onClick={() =>
            openSpawn(
              projectFilter === 'all' || projectFilter === 'shared-ssh'
                ? null
                : projectFilter,
              'branch',
            )
          }
        >
          <Plus size={15} />
          New agent
        </button>
      </header>
      <div className="office-filterbar">
        <label>
          View{' '}
          <select
            value={projectFilter}
            onChange={(e) => {
              setProjectFilter(e.target.value)
              setAgentFilter('all')
            }}
          >
            <option value="all">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="shared-ssh">Shared SSH</option>
          </select>
        </label>
        <label className="office-agent-filter">
          Agent{' '}
          <select
            value={agentFilter}
            onChange={(e) => setAgentFilter(e.target.value)}
          >
            <option value="all">All sessions</option>
            {data.members.map((m) => (
              <option key={m.key} value={m.key}>
                {m.title || m.agent || 'Untitled session'}
              </option>
            ))}
          </select>
        </label>
        <div className="office-filter-actions">
          <button
            className="office-button office-mobile-action"
            onClick={() => setPanel('activity')}
          >
            <Activity size={14} />
            Activity
          </button>
          <button
            className="office-button office-mobile-action"
            onClick={() => setPanel('sessions')}
          >
            <Users size={14} />
            Sessions
          </button>
          <button
            className="office-icon-button"
            aria-label="Refresh workspace"
            onClick={data.refresh}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>
      {data.catalogError && (
        <div role="alert" className="office-warning">
          Some catalog data could not be loaded.{' '}
          <button onClick={data.refresh}>Retry</button>
        </div>
      )}
      <div className="office-body">
        <aside className="office-activity-panel">{activityPanel}</aside>
        <section className="office-canvas" aria-label="Office view">
          <div className="office-canvas-toolbar">
            <span>
              <span className="office-live-dot" />{' '}
              {data.loading
                ? 'Connecting'
                : offline
                  ? 'Partial connection'
                  : 'Workspace live'}
            </span>
            <div>
              <button
                className="office-icon-button"
                aria-label={flat ? 'Show 3D office' : 'Show session list'}
                onClick={() => setFlat(!flat)}
              >
                {flat ? <Box size={15} /> : <List size={15} />}
              </button>
              <button
                className="office-icon-button"
                aria-label="Reset camera"
                onClick={() => setCameraReset((n) => n + 1)}
              >
                <Maximize2 size={15} />
              </button>
            </div>
          </div>
          {flat ? (
            <div className="office-flat-list">{sessionList}</div>
          ) : (
            <SceneBoundary key={workspace.id}>
              <Suspense
                fallback={
                  <div className="office-empty">Loading your office…</div>
                }
              >
                <OfficeScene
                  workspaceId={workspace.id}
                  members={allVisible}
                  allMembers={admitted}
                  projects={projects}
                  selectedKey={selected?.key}
                  visible={data.visible}
                  reset={cameraReset}
                  onSelect={choose}
                  onModule={openModule}
                />
              </Suspense>
            </SceneBoundary>
          )}
          {!data.loading && !data.members.length && (
            <div className="office-welcome">
              <h2>Your workspace, together.</h2>
              <p>
                {projects.length
                  ? 'Start an agent to bring this office to life.'
                  : 'Add a project in Agents to get started.'}
              </p>
            </div>
          )}
        </section>
        <aside className="office-sessions-panel">{sessionList}</aside>
      </div>
      <footer className="office-footer">
        <span>
          <span className="office-live-dot" />
          Real sessions · refreshes every 2s
        </span>
        <span>Shared SSH spans workspaces</span>
      </footer>
      <SideDrawer
        open={!!panel}
        onOpenChange={(open) => {
          if (!open) setPanel(null)
        }}
        width={340}
      >
        <div className="office-drawer-head">
          <DialogTitle>
            {panel === 'activity' ? 'Activity' : 'Sessions'}
          </DialogTitle>
          <button
            className="office-icon-button"
            aria-label="Close panel"
            onClick={() => setPanel(null)}
          >
            <X size={17} />
          </button>
        </div>
        {panel === 'activity' ? activityPanel : sessionList}
      </SideDrawer>
      <SideDrawer
        open={!!selection}
        onOpenChange={(open) => {
          if (!open) setSelection(null)
        }}
        width={640}
      >
        <div className="office-drawer-head">
          <div>
            <DialogTitle>
              {child?.title || selected?.title || 'Agent session'}
            </DialogTitle>
            <DialogDescription>
              {selected
                ? `${selected.agent} · ${selected.sourceName}${selected.connectionId ? ' · Shared SSH' : ''}`
                : 'Session no longer available'}
            </DialogDescription>
          </div>
          <button
            className="office-icon-button"
            aria-label="Close agent"
            onClick={() => setSelection(null)}
          >
            <X size={18} />
          </button>
        </div>
        {selected && (
          <div className="office-inspector-meta">
            <span
              className="office-status"
              style={{ color: statusColor(selected.status) }}
            >
              {selected.stale ? 'Connection unverified' : statusLabel(selected)}
            </span>
            <span>{selected.model}</span>
            {selectedWorktree && (
              <button
                className="office-button"
                onClick={() => openWorktree(selected)}
              >
                <GitBranch size={13} />
                {selectedWorktree.branch || 'Root terminal'}
                <ArrowUpRight size={13} />
              </button>
            )}
          </div>
        )}
        {child && (
          <div className="office-child-detail">
            <strong>Subagent · {child.role || child.status}</strong>
            <p>
              {child.activity || child.status}
              {child.tokens !== undefined
                ? ` · ${child.tokens.toLocaleString()} reported tokens`
                : ''}
            </p>
            <p>Continue in the parent conversation below.</p>
          </div>
        )}
        <Suspense
          fallback={<p className="office-note">Opening conversation…</p>}
        >
          {selected && !selected.stale ? (
            selected.connectionId && selected.machine ? (
              <SSHAgentChatPanel
                key={selected.key}
                connectionId={selected.connectionId}
                threadKey={selected.id}
                visible
              />
            ) : (
              <AgentChatPane
                key={selected.key}
                target={
                  selected.machine
                    ? { kind: 'machine', machine: selected.machine }
                    : { kind: 'hub' }
                }
                machine={selected.machine ?? LOCAL_MACHINE}
                threadKey={selected.id}
                worktreeId={selected.worktreeId}
                worktreeLabel={
                  selectedWorktree?.branch || selectedProject?.name
                }
                agentId={selected.agent}
                mentionSource={mentionSource}
              />
            )
          ) : (
            <p className="office-note">
              {selected
                ? 'Reconnect to this runtime before sending instructions.'
                : 'This session is no longer available.'}
            </p>
          )}
        </Suspense>
      </SideDrawer>
    </main>
  )
}

function SessionRow({
  member,
  selected,
  onSelect,
}: {
  member: OfficeMember
  selected: boolean
  onSelect: (m: OfficeMember, child?: string) => void
}) {
  return (
    <div className={`office-member ${selected ? 'is-selected' : ''}`}>
      <button
        className="office-member-main"
        onClick={() => onSelect(member)}
        aria-label={`${member.title || 'Untitled session'} · ${member.stale ? 'Unverified' : statusLabel(member)}`}
      >
        <span
          className="office-avatar-dot"
          style={{
            background: statusColor(member.stale ? 'unknown' : member.status),
          }}
        >
          {(member.agent || 'A').slice(0, 2).toUpperCase()}
        </span>
        <span>
          <strong>{member.title || 'Untitled session'}</strong>
          <small>
            {member.stale ? 'Unverified' : statusLabel(member)} ·{' '}
            {member.agent || 'Agent'}
          </small>
        </span>
        <ArrowUpRight size={12} />
      </button>
      {member.subagents.length > 0 && (
        <details className="office-subagents">
          <summary>{member.subagents.length} subagents</summary>
          {member.subagents.map((child) => (
            <button key={child.id} onClick={() => onSelect(member, child.id)}>
              <span style={{ color: statusColor(child.status) }}>●</span>
              {child.title || child.role || 'Subagent'}
              <small>{child.status}</small>
            </button>
          ))}
        </details>
      )}
    </div>
  )
}

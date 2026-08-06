import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  useBookmarks,
  useCreateSSHConnection,
  useMachines,
  useMachinesHealth,
  useSSHConnections,
  useWorkspace,
} from '@/features/data/queries'
import { parseSSHCommand } from '@/features/ssh/sshCommand'
import {
  applyIdentityFile,
  buildSSHQuickAddPlan,
  defaultSSHQuickAddDraft,
  deriveSSHQuickAddName,
  isSSHQuickAddValid,
  type QuickAddPlan,
  type SSHQuickAddDraft,
} from '@/features/ssh/sshQuickAdd'
import { MODULE_ICON } from '@/features/tabs/tabIcons'
import { createDefaultTileLayout, findTileTab, focusTileLeaf, selectTileTab } from '@/features/tabs/tileTree'
import type { TileNode, TileTab } from '@/features/tabs/tileTree'
import {
  addContentToLeaf,
  createDefaultLayout,
  createStatsContent,
  deserializeLayout,
  findLeafForContent,
  selectTabInTree,
} from '@/features/terminal/paneTree'
import { worktreeLabel, worktreeTabLabel } from '@/lib/worktreeLabel'
import { computeCompletion } from '@/features/palette/paletteComplete'
import {
  frecencyScore,
  loadFrecency,
  pruneFrecency,
  recordUse,
  saveFrecency,
  type FrecencyMap,
} from '@/features/palette/paletteFrecency'
import { MAX_ROWS_PER_GROUP, flattenRanked, rankPaletteItems } from '@/features/palette/paletteRank'
import { bookmarkItems, normalizeUrl } from '@/features/palette/providers/bookmarks'
import { matchVerb, sshCommandPreview, verbHintItems } from '@/features/palette/providers/commands'
import { agentProjectRows, createActionItems } from '@/features/palette/providers/createActions'
import type { CreateActionDeps } from '@/features/palette/providers/createActions'
import { entityItems } from '@/features/palette/providers/entities'
import type { EntityActions, EntitySources } from '@/features/palette/providers/entities'
import { openTabItems } from '@/features/palette/providers/openTabs'
import type { TabLabel } from '@/features/palette/providers/openTabs'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type {
  PaletteItem,
  PalettePage,
  PaletteRunContext,
  RankedGroup,
  RankedItem,
} from '@/features/palette/paletteTypes'
import type { ParsedSSHCommand } from '@/features/ssh/sshCommand'

export interface PaletteItemSources {
  query: string
  openTabs: PaletteItem[]
  entities: PaletteItem[]
  bookmarks: PaletteItem[]
  verbHints: PaletteItem[]
  createActions: PaletteItem[]
  recent: PaletteItem[]
}

/**
 * Combines every provider's rows into the flat list `rankPaletteItems`
 * groups and filters. On an **empty** query, `entities`, `bookmarks` and
 * `verbHints` are omitted entirely (not merely out-scored) — per spec
 * Decision 5, an empty query shows only Open tabs → Recent → Create;
 * feeding every worktree/project/host/machine/page in unconditionally
 * would flood the Results group the instant the palette opens.
 */
export function assemblePaletteItems(sources: PaletteItemSources): PaletteItem[] {
  const { query, openTabs, entities, bookmarks, verbHints, createActions, recent } = sources
  if (query.trim() === '') return [...openTabs, ...recent, ...createActions]
  return [...openTabs, ...recent, ...entities, ...bookmarks, ...verbHints, ...createActions]
}

/**
 * The string rows are filtered and scored against.
 *
 * When a verb has taken over the input, its rows are titled with the *entity*
 * name (`superapps_mabes`), not the typed text (`agent-new mabes`) — scoring
 * against the full query matches nothing and the verb renders empty. A
 * drill-down page keeps the raw query, because its own input is already
 * reset when the page is pushed.
 */
export function paletteRankQuery(deferredQuery: string, verbArg: string | null, hasActivePage: boolean): string {
  if (hasActivePage) return deferredQuery
  return verbArg ?? deferredQuery
}

export interface CommandPaletteModel {
  query: string
  setQuery: (q: string) => void
  groups: RankedGroup[]
  rows: RankedItem[]
  selectedIndex: number
  setSelectedIndex: (i: number) => void
  ghost: string
  breadcrumbs: string[]
  placeholder: string
  sshPreview: { summary: string; ignored: string[] } | null
  moveSelection: (delta: number) => void
  acceptCompletion: () => boolean
  drillIn: () => boolean
  drillOut: () => boolean
  /** `index` targets a row other than the selected one — a pointer click can
   *  arrive without the `mouseenter` that would otherwise have moved the
   *  selection first (touch, or a click landing straight on a row). */
  run: (modifiers?: { forceForm?: boolean; index?: number }) => void
}

const ROOT_PLACEHOLDER = 'Search tabs, worktrees, hosts — or type ssh / agent-new / browser…'

/**
 * `APP_PAGES` paths mapped to the real route ids. A template literal built
 * from a plain `string` is not assignable to TanStack Router's `to`, so the
 * mapping is spelled out and the union of literals is what gets passed.
 */
const PAGE_ROUTES = {
  '': '/w/$wsId',
  machines: '/w/$wsId/machines',
  database: '/w/$wsId/database',
  ssh: '/w/$wsId/ssh',
  browser: '/w/$wsId/browser',
  tools: '/w/$wsId/tools',
  todos: '/w/$wsId/todos',
  invoices: '/w/$wsId/invoices',
  news: '/w/$wsId/news',
  management: '/w/$wsId/management',
} as const

/** Ids `entityItems` assigns to the two tab kinds that map 1:1 onto an entity,
 *  so a Results row for something already open can be scored as such. */
function collectOpenEntityIds(node: TileNode, into: Set<string>): Set<string> {
  if (node.type === 'leaf') {
    for (const tab of node.tabs) {
      if (tab.kind === 'worktree') into.add(`worktree:${tab.wtId}`)
      else if (tab.kind === 'ssh-shell') into.add(`ssh:${tab.connectionId}`)
    }
    return into
  }
  for (const child of node.children) collectOpenEntityIds(child, into)
  return into
}

/**
 * The palette's state machine: query, drill-down page stack, selection, ghost
 * text, and the one `run` that every key path funnels through.
 *
 * Everything it renders comes from the already-warm zustand store and
 * react-query cache — the providers are pure functions over that data, so
 * opening the palette costs no network round trip.
 */
export function useCommandPalette({
  wsId,
  leafId,
  open,
}: {
  wsId: string
  leafId: string
  open: boolean
}): CommandPaletteModel {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [pages, setPages] = useState<PalettePage[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [frecency, setFrecency] = useState<FrecencyMap>({})
  // Matches FileQuickOpen: typing stays responsive while a large item list
  // re-ranks in a lower-priority render.
  const deferredQuery = useDeferredValue(query)

  const showToast = useDevDeckStore((s) => s.showToast)
  const closePalette = useDevDeckStore((s) => s.closePalette)
  const openSSHQuickAdd = useDevDeckStore((s) => s.openSSHQuickAdd)
  const openWorktreeTab = useDevDeckStore((s) => s.openWorktreeTab)
  const openSSHShellTab = useDevDeckStore((s) => s.openSSHShellTab)
  const openBrowserTab = useDevDeckStore((s) => s.openBrowserTab)
  const openSpawn = useDevDeckStore((s) => s.openSpawn)
  const selectAgentsTab = useDevDeckStore((s) => s.selectAgentsTab)
  const setWorkspaceTileLayout = useDevDeckStore((s) => s.setWorkspaceTileLayout)
  const setSSHTileLayout = useDevDeckStore((s) => s.setSSHTileLayout)
  const storedLayout = useDevDeckStore((s) => s.workspaceTileLayouts[wsId])
  const layout = useMemo(() => storedLayout ?? createDefaultTileLayout(), [storedLayout])

  const workspaceQuery = useWorkspace(wsId)
  const machinesQuery = useMachines()
  const connectionsQuery = useSSHConnections()
  const bookmarksQuery = useBookmarks()
  const createConnection = useCreateSSHConnection()

  const projects = useMemo(() => workspaceQuery.data?.projects ?? [], [workspaceQuery.data])
  const machines = useMemo(() => machinesQuery.data ?? [], [machinesQuery.data])
  const connections = useMemo(() => connectionsQuery.data ?? [], [connectionsQuery.data])
  const bookmarks = useMemo(() => bookmarksQuery.data ?? [], [bookmarksQuery.data])
  const machineHealth = useMachinesHealth(machines)

  const offlineMachineIds = useMemo(() => {
    const offline = new Set<string>()
    for (const machine of machines) {
      if (machineHealth.get(machine.id)?.status === 'offline') offline.add(machine.id)
    }
    return offline
  }, [machines, machineHealth])

  // ---- provider input shapes -------------------------------------------
  // `EntitySources` / `CreateActionDeps` are adapted shapes, not literal
  // domain-type subsets: `SSHConnection` names its field `username`, and a
  // `Worktree` carries neither a `name` nor its owning `projectId` (the
  // association exists only by nesting inside `Project.worktrees`).

  const paletteProjects = useMemo(
    () =>
      projects.map((project) => ({
        id: project.id,
        name: project.name,
        machineId: project.machineId,
        path: project.path,
      })),
    [projects],
  )
  const paletteWorktrees = useMemo(
    () =>
      projects.flatMap((project) =>
        project.worktrees.map((worktree) => ({
          id: worktree.id,
          projectId: project.id,
          branch: worktree.branch,
          // A root shell has no branch at all, so `branch` alone would render a
          // blank row — `worktreeLabel` numbers them ("root - shell 2") the way
          // every other surface does.
          name: worktreeLabel(project, worktree),
        })),
      ),
    [projects],
  )
  const paletteConnections = useMemo(
    () => connections.map((connection) => ({ ...connection, user: connection.username })),
    [connections],
  )
  const paletteMachines = useMemo(() => machines.map((m) => ({ id: m.id, name: m.name })), [machines])
  const paletteBookmarks = useMemo(
    () => bookmarks.map((b) => ({ id: b.id, title: b.title, url: b.url })),
    [bookmarks],
  )
  const defaultMachineId = machines[0]?.id

  // ---- actions ----------------------------------------------------------

  const navigateToTab = useCallback(
    (tab: TileTab) => {
      if (tab.kind === 'worktree') {
        navigate({ to: '/w/$wsId/p/$projectId/wt/$wtId', params: { wsId, projectId: tab.projectId, wtId: tab.wtId } })
      } else if (tab.kind === 'browser') {
        navigate({ to: '/w/$wsId/browser', params: { wsId } })
      } else {
        navigate({ to: '/w/$wsId', params: { wsId } })
      }
    },
    [navigate, wsId],
  )

  /** The "window switcher" half: move focus to a tab that is already open
   *  rather than opening anything. */
  const focusTab = useCallback(
    (targetLeafId: string, tabId: string) => {
      const current = useDevDeckStore.getState().workspaceTileLayouts[wsId]
      if (!current) return
      setWorkspaceTileLayout(wsId, focusTileLeaf(selectTileTab(current, targetLeafId, tabId), targetLeafId))
      const tab = findTileTab(current.root, tabId)
      if (tab) navigateToTab(tab)
    },
    [wsId, setWorkspaceTileLayout, navigateToTab],
  )

  const openUrl = useCallback(
    (url: string) => {
      openBrowserTab(wsId, defaultMachineId, url)
      navigate({ to: '/w/$wsId/browser', params: { wsId } })
    },
    [openBrowserTab, wsId, defaultMachineId, navigate],
  )

  const entityActions = useMemo<EntityActions>(
    () => ({
      // `openWorktreeTab` / `openSSHShellTab` both delegate to `openTileTab`,
      // which focuses an existing tab instead of duplicating it — the spec's
      // "Duplicate open" edge case, already handled one layer down.
      openWorktree: (projectId, wtId) => {
        openWorktreeTab(wsId, projectId, wtId)
        navigate({ to: '/w/$wsId/p/$projectId/wt/$wtId', params: { wsId, projectId, wtId } })
      },
      openProject: (projectId) => {
        selectAgentsTab(wsId)
        navigate({ to: '/w/$wsId/p/$projectId', params: { wsId, projectId } })
      },
      openSSH: (connectionId) => {
        openSSHShellTab(wsId, connectionId)
        navigate({ to: '/w/$wsId', params: { wsId } })
      },
      openMachine: () => navigate({ to: '/w/$wsId/machines', params: { wsId } }),
      openPage: (path) => {
        const to = PAGE_ROUTES[path as keyof typeof PAGE_ROUTES] ?? PAGE_ROUTES['']
        navigate({ to, params: { wsId } })
      },
    }),
    [wsId, navigate, openWorktreeTab, openSSHShellTab, selectAgentsTab],
  )

  const resolveTabLabel = useCallback(
    (tab: TileTab): TabLabel => {
      if (tab.kind === 'agents') return { title: 'Agents', subtitle: 'workspace' }
      if (tab.kind === 'worktree') {
        const project = projects.find((p) => p.id === tab.projectId)
        const worktree = project?.worktrees.find((w) => w.id === tab.wtId)
        if (!worktree) return { title: 'Worktree' }
        const machineName = project?.machineId
          ? (machines.find((m) => m.id === project.machineId)?.name ?? 'local')
          : 'local'
        const label = worktreeTabLabel(project, worktree, machineName)
        return { title: label.name, subtitle: label.prefix }
      }
      if (tab.kind === 'browser') {
        const tile = useDevDeckStore.getState().browserTiles[tab.id]
        const doc = tile?.docs.find((d) => d.id === tile.activeDocId)
        return { title: doc?.title || 'Web', subtitle: doc?.url || undefined }
      }
      const connection = connections.find((c) => c.id === tab.connectionId)
      return {
        title: connection?.name ?? 'SSH',
        subtitle: connection ? `${connection.username}@${connection.host}` : undefined,
      }
    },
    [projects, machines, connections],
  )

  // ---- SSH command path -------------------------------------------------

  /** Runs the plan in order, threading each created row's id into the next
   *  step's `jumpConnectionId`. Returns the target connection's id. */
  const runPlan = useCallback(
    async (plan: QuickAddPlan): Promise<string> => {
      let previousId: string | null = null
      for (const step of plan.steps) {
        if (step.kind === 'existing') {
          previousId = step.id
          continue
        }
        const created = await createConnection.mutateAsync({ ...step.body, jumpConnectionId: previousId })
        previousId = created.id
      }
      // buildSSHQuickAddPlan always ends with a `create` step for the target.
      return previousId as string
    },
    [createConnection],
  )

  const runSSHQuickAdd = useCallback(
    async (parsed: ParsedSSHCommand, draft: SSHQuickAddDraft) => {
      // The create chain below has a real `await` before it opens the shell or
      // closes the palette. If the user navigates to a different workspace
      // while it's in flight, `wsId` keeps pointing at the workspace that was
      // open when Enter was pressed (WorkspaceTileArea is never remounted on a
      // route change), so blindly opening the tab after the await would yank
      // the user back to that stale workspace and `closePalette()` would
      // dismiss whatever they've since opened elsewhere. Re-check the
      // *current* store state right before doing either — the connection
      // itself stays saved regardless.
      const submittedWsId = wsId
      try {
        const connectionId = await runPlan(buildSSHQuickAddPlan(parsed, draft, connections))
        showToast(`Added SSH connection "${draft.name.trim()}"`)
        if (useDevDeckStore.getState().palette.wsId === submittedWsId) {
          closePalette()
          openSSHShellTab(submittedWsId, connectionId)
          navigate({ to: '/w/$wsId', params: { wsId: submittedWsId } })
        }
      } catch (err) {
        // Hops created before the failure stay saved on purpose — a retry
        // reuse-matches them instead of duplicating them. The palette stays
        // open with the input intact so the command can be corrected.
        showToast(err instanceof Error ? err.message : 'Failed to add SSH connection')
      }
    },
    [wsId, runPlan, connections, showToast, closePalette, openSSHShellTab, navigate],
  )

  const verbMatch = useMemo(() => matchVerb(deferredQuery), [deferredQuery])
  const sshParsed = useMemo(
    () => (verbMatch?.verb.name === 'ssh' ? parseSSHCommand(`ssh ${verbMatch.arg}`) : null),
    [verbMatch],
  )
  const sshDraft = useMemo<SSHQuickAddDraft | null>(() => {
    if (!sshParsed) return null
    const base = defaultSSHQuickAddDraft()
    return applyIdentityFile(
      { ...base, raw: `ssh ${verbMatch?.arg ?? ''}`, name: deriveSSHQuickAddName(sshParsed) },
      sshParsed,
    )
  }, [sshParsed, verbMatch])
  const sshPreview = useMemo(
    () => (verbMatch?.verb.name === 'ssh' ? sshCommandPreview(verbMatch.arg) : null),
    [verbMatch],
  )
  const sshValid = useMemo(
    () => (sshParsed && sshDraft ? isSSHQuickAddValid(sshParsed, sshDraft, connections) : false),
    [sshParsed, sshDraft, connections],
  )

  /** `prefillRaw` seeds the dialog's ssh-command field verbatim, so it must be
   *  the whole command (`ssh root@host -J …`), not just the verb's argument —
   *  that is what the user typed and what the field is labelled for.
   *  `parseSSHCommand` strips the leading `ssh` token itself. */
  const openQuickAddForm = useCallback(
    (prefillRaw: string) => {
      openSSHQuickAdd(wsId, leafId, prefillRaw)
      closePalette()
    },
    [openSSHQuickAdd, wsId, leafId, closePalette],
  )

  /** "New Stats view…"'s per-host row — ensures a Stats pane for this host
   *  exists (or is refocused) in its shell tab's own pane tree, using the
   *  same `createStatsContent` dedupe-by-target-key rule the "+" menu's
   *  entry point relies on, then opens/focuses that shell tab. Reads the
   *  live store directly (not the `sshTileLayouts` slice via a hook) because
   *  this only ever runs from a `run()` callback, never a render. */
  const openSSHStats = useCallback(
    (connectionId: string) => {
      const stored = useDevDeckStore.getState().sshTileLayouts[connectionId]
      const sshLayout = deserializeLayout(stored) ?? createDefaultLayout(connectionId)
      const content = createStatsContent({ kind: 'ssh', connectionId }, 'Stats')
      const existingLeaf = findLeafForContent(sshLayout.root, content.id)
      const nextLayout = existingLeaf
        ? {
            ...sshLayout,
            root: selectTabInTree(sshLayout.root, existingLeaf.id, content.id),
            focusedPaneId: existingLeaf.id,
          }
        : {
            ...sshLayout,
            root: addContentToLeaf(sshLayout.root, sshLayout.focusedPaneId, content),
            focusedPaneId: sshLayout.focusedPaneId,
          }
      setSSHTileLayout(connectionId, nextLayout)
      openSSHShellTab(wsId, connectionId)
      navigate({ to: '/w/$wsId', params: { wsId } })
    },
    [setSSHTileLayout, openSSHShellTab, wsId, navigate],
  )

  // ---- item assembly ----------------------------------------------------

  const openTabs = useMemo(
    () => openTabItems(layout, resolveTabLabel, focusTab),
    [layout, resolveTabLabel, focusTab],
  )

  const entitySources = useMemo<EntitySources>(
    () => ({
      wsId,
      worktrees: paletteWorktrees,
      projects: paletteProjects,
      sshConnections: paletteConnections,
      machines: paletteMachines,
      offlineMachineIds,
    }),
    [wsId, paletteWorktrees, paletteProjects, paletteConnections, paletteMachines, offlineMachineIds],
  )
  const entities = useMemo(() => entityItems(entitySources, entityActions), [entitySources, entityActions])

  const bookmarkRows = useMemo(
    () => bookmarkItems(paletteBookmarks, deferredQuery, openUrl),
    [paletteBookmarks, deferredQuery, openUrl],
  )
  const verbHints = useMemo(() => verbHintItems(deferredQuery), [deferredQuery])

  const createDeps = useMemo<CreateActionDeps>(
    () => ({
      query: deferredQuery,
      machines: paletteMachines,
      projects: paletteProjects,
      sshConnections: paletteConnections,
      offlineMachineIds,
      openBrowser: (machineId) => {
        openBrowserTab(wsId, machineId)
        navigate({ to: '/w/$wsId/browser', params: { wsId } })
      },
      openSSHConnection: (connectionId) => {
        openSSHShellTab(wsId, connectionId)
        navigate({ to: '/w/$wsId', params: { wsId } })
      },
      openSSHQuickAdd: (prefillRaw) => openQuickAddForm(prefillRaw),
      openSpawn: (projectId) => openSpawn(projectId),
      openSSHStats: (connectionId) => openSSHStats(connectionId),
    }),
    [
      deferredQuery,
      paletteMachines,
      paletteProjects,
      paletteConnections,
      offlineMachineIds,
      openBrowserTab,
      openSSHShellTab,
      openQuickAddForm,
      openSpawn,
      openSSHStats,
      navigate,
      wsId,
    ],
  )
  const createActions = useMemo(() => createActionItems(createDeps), [createDeps])

  const openEntityIds = useMemo(() => collectOpenEntityIds(layout.root, new Set<string>()), [layout])
  const isEntityOpen = useCallback((id: string) => openEntityIds.has(id), [openEntityIds])

  const frecencyRef = useRef<FrecencyMap>({})
  const applyFrecency = useCallback((next: FrecencyMap) => {
    frecencyRef.current = next
    setFrecency(next)
  }, [])

  /**
   * Frecent entities, re-labelled into the `recent` group.
   *
   * Only built for an **empty** query. Once something is typed, the same
   * entity would also be produced by `entityItems` in the `results` group,
   * and two rows sharing one id would break both `aria-activedescendant` and
   * arrow-key selection. An empty query is also the only moment Decision 5
   * asks for a Recent group at all.
   */
  const recent = useMemo(() => {
    if (deferredQuery.trim() !== '') return []
    // An empty query means `bookmarkRows` is exactly the saved bookmarks —
    // `bookmarkItems` only appends its transient `url:` row for a URL-shaped
    // query — so they can be resolved alongside entities without duplicates.
    const byId = new Map([...entities, ...bookmarkRows].map((item) => [item.id, item]))
    const now = Date.now()
    return Object.keys(frecency)
      .filter((id) => byId.has(id) && !openEntityIds.has(id))
      .sort((a, b) => frecencyScore(frecency, b, now) - frecencyScore(frecency, a, now))
      .slice(0, MAX_ROWS_PER_GROUP)
      .map((id) => ({ ...(byId.get(id) as PaletteItem), group: 'recent' as const }))
  }, [deferredQuery, entities, bookmarkRows, frecency, openEntityIds])

  const runContext = useMemo<PaletteRunContext>(
    () => ({ wsId, leafId, showToast, close: closePalette }),
    [wsId, leafId, showToast, closePalette],
  )

  /** A typed verb with an argument takes the input over completely — but the
   *  Create rows still ride along, because Decision 2 makes them
   *  unconditional. */
  const verbItems = useMemo<PaletteItem[] | null>(() => {
    if (!verbMatch) return null
    const { verb, arg } = verbMatch

    if (verb.name === 'ssh') {
      if (!sshParsed || !sshDraft) {
        return [
          {
            id: 'command:ssh',
            kind: 'command',
            group: 'results',
            title: `New SSH host from "${arg}"…`,
            subtitle: "couldn't read that as an ssh command — opens the form",
            icon: MODULE_ICON.ssh,
            run: () => openQuickAddForm(`ssh ${arg}`),
          },
        ]
      }
      return [
        {
          id: 'command:ssh',
          kind: 'command',
          group: 'results',
          title: sshValid ? `Connect & save "${sshDraft.name}"` : `New SSH host "${sshDraft.name}"…`,
          subtitle: sshValid ? 'creates the host and opens a shell' : 'needs credentials — opens the form',
          // This row *is* the typed command, so matching it against that same
          // command has to be a tautology. It can't be left to the title:
          // `deriveSSHQuickAddName` names the row after the target alone
          // (`root@host`), so `ssh root@host -J bastion` would score
          // `root@host -J bastion` against `Connect & save "root@host"` — no
          // substring, and the subsequence walk dies at the space — and the
          // row would vanish exactly when the command is most worth confirming.
          keywords: [arg],
          icon: MODULE_ICON.ssh,
          run: sshValid ? () => runSSHQuickAdd(sshParsed, sshDraft) : () => openQuickAddForm(sshDraft.raw),
        },
      ]
    }

    // rankPaletteItems now filters these rows itself, using every facet
    // (name, machine, path) — see `paletteRankQuery` below for why that only
    // works once the rows are scored against `arg`, not the full query.
    if (verb.name === 'agent-new') return agentProjectRows(createDeps, 'command:agent-new')

    const url = normalizeUrl(arg)
    return [
      {
        id: 'command:browser',
        kind: 'url',
        group: 'results',
        title: url,
        subtitle: defaultMachineId ? 'open in a Browser tile' : 'no machine registered',
        // Same tautology as the ssh row above: `normalizeUrl` can rewrite the
        // argument beyond recognition, and this row is the typed input.
        keywords: [arg],
        icon: MODULE_ICON.browser,
        disabled: defaultMachineId ? undefined : { reason: 'Register a machine before opening a Browser tile' },
        run: () => openUrl(url),
      },
    ]
  }, [verbMatch, sshParsed, sshDraft, sshValid, runSSHQuickAdd, openQuickAddForm, createDeps, defaultMachineId, openUrl])

  const activePage = pages.length > 0 ? pages[pages.length - 1] : null

  const items = useMemo(() => {
    if (activePage) return activePage.items(deferredQuery, runContext)
    if (verbItems) return [...verbItems, ...createActions]
    return assemblePaletteItems({
      query: deferredQuery,
      openTabs,
      entities,
      bookmarks: bookmarkRows,
      verbHints,
      createActions,
      recent,
    })
  }, [
    activePage,
    deferredQuery,
    runContext,
    verbItems,
    openTabs,
    entities,
    bookmarkRows,
    verbHints,
    createActions,
    recent,
  ])

  const frecencyFor = useCallback((id: string) => frecencyScore(frecency, id, Date.now()), [frecency])

  // Whenever verbItems is active, `items` is only [...verbItems, ...createActions],
  // and Create rows bypass filtering anyway — so scoring against the verb's
  // argument instead of the full query is safe here, and it's what fixes the
  // dead-verb bug (see `paletteRankQuery`'s doc comment). It also fixes
  // highlight ranges, which are computed from this same query.
  const rankQuery = paletteRankQuery(deferredQuery, verbMatch?.arg ?? null, activePage !== null)
  const groups = useMemo(
    () => rankPaletteItems(items, rankQuery, frecencyFor, isEntityOpen),
    [items, rankQuery, frecencyFor, isEntityOpen],
  )
  const rows = useMemo(() => flattenRanked(groups), [groups])

  // ---- selection --------------------------------------------------------

  useEffect(() => {
    setSelectedIndex(0)
  }, [deferredQuery, pages])

  const clampedIndex = rows.length === 0 ? 0 : Math.min(selectedIndex, rows.length - 1)
  const selectedRow = rows[clampedIndex]

  const moveSelection = useCallback(
    (delta: number) => {
      setSelectedIndex((current) => {
        if (rows.length === 0) return 0
        const base = Math.min(current, rows.length - 1)
        return (base + delta + rows.length) % rows.length
      })
    },
    [rows.length],
  )

  // ---- frecency lifecycle -----------------------------------------------

  useEffect(() => {
    if (!open) return
    const loaded = loadFrecency(wsId)
    frecencyRef.current = loaded
    setFrecency(loaded)
    setQuery('')
    setPages([])
    setSelectedIndex(0)
  }, [open, wsId])

  // Every id frecency is allowed to remember. Deliberately query-independent,
  // so a prune can never depend on what happens to be typed. Ids that are not
  // in here (open-tab rows, Create rows, one-off `url:` rows) are meant to be
  // dropped — they name a moment, not a thing that can be reopened.
  const liveIds = useMemo(
    () => new Set([...entities.map((entity) => entity.id), ...paletteBookmarks.map((b) => `bookmark:${b.id}`)]),
    [entities, paletteBookmarks],
  )
  const entitiesLoaded =
    workspaceQuery.isSuccess && machinesQuery.isSuccess && connectionsQuery.isSuccess && bookmarksQuery.isSuccess

  // Prune ids that no longer resolve — but only once every entity list has
  // actually loaded, or a still-cold cache would look like "everything was
  // deleted" and wipe the map.
  useEffect(() => {
    if (!open || !entitiesLoaded) return
    const pruned = pruneFrecency(frecencyRef.current, liveIds)
    if (pruned === frecencyRef.current) return
    applyFrecency(pruned)
    saveFrecency(wsId, pruned)
  }, [open, entitiesLoaded, liveIds, wsId, applyFrecency])

  // ---- commands ---------------------------------------------------------

  const ghost = computeCompletion(query, selectedRow?.completion ?? selectedRow?.title)

  const acceptCompletion = useCallback(() => {
    if (!ghost) return false
    setQuery((current) => current + ghost)
    return true
  }, [ghost])

  const drillIn = useCallback((index?: number) => {
    const row = rows[index ?? clampedIndex]
    if (!row?.drillInto) return false
    const page = row.drillInto()
    setPages((current) => [...current, page])
    setQuery('')
    return true
  }, [rows, clampedIndex])

  const drillOut = useCallback(() => {
    if (pages.length === 0) return false
    setPages((current) => current.slice(0, -1))
    setQuery('')
    return true
  }, [pages.length])

  const run = useCallback(
    (modifiers?: { forceForm?: boolean; index?: number }) => {
      const index = modifiers?.index ?? clampedIndex
      const row = rows[index]
      if (!row) return

      // A disabled row must refuse, loudly — never fail silently and never
      // half-run.
      if (row.disabled) {
        showToast(row.disabled.reason)
        return
      }

      // Shift+Enter always takes the ssh command to the form instead of
      // firing the create chain, however valid it looks.
      if (modifiers?.forceForm && verbMatch?.verb.name === 'ssh' && row.id === 'command:ssh') {
        openQuickAddForm(`ssh ${verbMatch.arg}`)
        return
      }

      if (!row.run) {
        // A Create row is a drill-in, not an action — Enter should still open it.
        drillIn(index)
        return
      }

      const next = recordUse(frecencyRef.current, row.id, Date.now())
      applyFrecency(next)
      saveFrecency(wsId, next)

      const result = row.run(runContext)
      // An async row (the SSH create chain) owns its own close, because it
      // must re-check the live workspace after the await before touching any
      // navigation — see `runSSHQuickAdd`.
      if (result instanceof Promise) return
      closePalette()
    },
    [
      rows,
      clampedIndex,
      showToast,
      verbMatch,
      openQuickAddForm,
      drillIn,
      applyFrecency,
      wsId,
      runContext,
      closePalette,
    ],
  )

  return {
    query,
    setQuery,
    groups,
    rows,
    selectedIndex: clampedIndex,
    setSelectedIndex,
    ghost,
    breadcrumbs: pages.map((page) => page.breadcrumb),
    placeholder: activePage?.placeholder ?? ROOT_PLACEHOLDER,
    sshPreview,
    moveSelection,
    acceptCompletion,
    drillIn,
    drillOut,
    run,
  }
}

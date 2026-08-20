import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  addGlobalPreference,
  exportMemoryBrain,
  fetchMemoryConfig,
  fetchMemoryEntityGraph,
  fetchMemoryGraph,
  fetchMemoryLocalLogs,
  fetchMemoryLocalStatus,
  fetchMemoryOperations,
  fetchMemoryStats,
  fetchMemoryTags,
  fetchMemoryTimeseries,
  fetchMemoryUnits,
  importMemoryBrain,
  reflectMemory,
  searchMemory,
  startMemoryLocal,
  stopMemoryLocal,
  testMemoryConnection,
  updateMemoryConfig,
  type MemoryConfigPatch,
  type MemoryImportMode,
} from '@/lib/api'
import { qk } from '@/features/data/keys'

export function useMemoryConfig() {
  return useQuery({ queryKey: qk.memoryConfig, queryFn: fetchMemoryConfig })
}

export function useUpdateMemoryConfig() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: MemoryConfigPatch) => updateMemoryConfig(patch),
    onSuccess: (data) => {
      queryClient.setQueryData(qk.memoryConfig, data)
      // Everything else on the Memory page reads from the bank this config
      // points at — a changed bank id or base URL makes every other cached
      // view stale, not just the config form itself.
      void queryClient.invalidateQueries({ queryKey: ['memory'] })
    },
  })
}

export function useTestMemoryConnection() {
  return useMutation({
    mutationFn: (args: { baseUrl: string; apiKey: string }) => testMemoryConnection(args.baseUrl, args.apiKey),
  })
}

// ---- Local hosting lifecycle ("container" / "baremetal") ----
//
// Only meaningful while Hosting is one of those two modes — `enabled` gates
// both the fetch and the poll, the same convention useTerminalSessions uses,
// so this query is a no-op (and never throws the 400 the backend returns for
// "hosting is manual") whenever the Settings panel isn't showing a local
// deployment picker.

export function useMemoryLocalStatus(enabled: boolean) {
  return useQuery({
    queryKey: qk.memoryLocalStatus,
    queryFn: fetchMemoryLocalStatus,
    enabled,
    refetchInterval: enabled ? 3000 : false,
  })
}

export function useStartMemoryLocal() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: startMemoryLocal,
    onSuccess: (status) => {
      queryClient.setQueryData(qk.memoryLocalStatus, status)
      // Start also derives and saves a new baseUrl/enabled/localRunning on
      // the backend — refetch the config so the form reflects it without
      // the operator having to reopen the panel.
      void queryClient.invalidateQueries({ queryKey: qk.memoryConfig })
    },
  })
}

export function useStopMemoryLocal() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: stopMemoryLocal,
    onSuccess: (status) => {
      queryClient.setQueryData(qk.memoryLocalStatus, status)
      void queryClient.invalidateQueries({ queryKey: qk.memoryConfig })
    },
  })
}

export function useMemoryLocalLogs(enabled: boolean, intervalMs = 3000) {
  return useQuery({
    queryKey: qk.memoryLocalLogs,
    queryFn: () => fetchMemoryLocalLogs(200),
    enabled,
    refetchInterval: enabled ? intervalMs : false,
  })
}

/** Only runs once memory is configured — a disabled/unset feature has no bank
 *  to report stats for, and the browse endpoints answer 503 until it is. */
export function useMemoryStats(enabled: boolean) {
  return useQuery({ queryKey: qk.memoryStats, queryFn: fetchMemoryStats, enabled })
}

/** What Hindsight is doing right now — fact extraction, consolidation, a
 *  mental-model refresh. Polls while there's something to watch; the query
 *  itself decides the interval (fast while anything is pending/running, off
 *  once everything has settled) so the Overview tab doesn't hammer the
 *  server once a bank goes quiet. */
export function useMemoryOperations(enabled: boolean) {
  return useQuery({
    queryKey: qk.memoryOperations,
    queryFn: () => fetchMemoryOperations(20),
    enabled,
    refetchInterval: (query) => {
      const ops = query.state.data?.operations ?? []
      const active = ops.some((o) => o.status === 'pending' || o.status === 'running')
      return active ? 2000 : false
    },
  })
}

export function useMemoryTags(enabled: boolean, q = '') {
  return useQuery({ queryKey: qk.memoryTags(q), queryFn: () => fetchMemoryTags({ q: q || undefined }), enabled })
}

export function useMemoryUnits(
  enabled: boolean,
  params: { type?: string; q?: string; tags?: string[]; offset?: number } = {},
) {
  return useQuery({
    queryKey: qk.memoryUnits(params),
    queryFn: () => fetchMemoryUnits({ ...params, limit: 50 }),
    enabled,
  })
}

export function useMemoryGraph(enabled: boolean, params: { type?: string; q?: string } = {}) {
  return useQuery({
    queryKey: qk.memoryGraph(params),
    queryFn: () => fetchMemoryGraph({ ...params, limit: 150 }),
    enabled,
  })
}

export function useMemoryEntityGraph(enabled: boolean) {
  return useQuery({
    queryKey: qk.memoryEntityGraph,
    queryFn: () => fetchMemoryEntityGraph({ limit: 150, minCount: 1 }),
    enabled,
  })
}

export function useMemoryTimeseries(enabled: boolean, period: '7d' | '30d' | '90d' = '30d') {
  return useQuery({
    queryKey: qk.memoryTimeseries(period),
    queryFn: () => fetchMemoryTimeseries(period),
    enabled,
  })
}

export function useSearchMemory() {
  return useMutation({
    mutationFn: (args: { query: string; tags?: string[] }) => searchMemory({ query: args.query, tags: args.tags, budget: 'high', maxTokens: 4096 }),
  })
}

export function useReflectMemory() {
  return useMutation({
    mutationFn: (query: string) => reflectMemory({ query, budget: 'high', maxTokens: 4096 }),
  })
}

/** Adds one preference to the cross-project global tier. A new global fact
 *  changes what every project's recall can see and shows up in the Overview's
 *  stats/tags, so success resyncs the whole memory view. */
export function useAddGlobalPreference() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (text: string) => addGlobalPreference(text),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memory'] })
    },
  })
}

/** Downloads the bank's full content as a transfer ZIP — the "Export Brain"
 *  button. No cache invalidation: exporting doesn't change the bank. */
export function useExportMemoryBrain() {
  return useMutation({ mutationFn: exportMemoryBrain })
}

/** Uploads a transfer ZIP into the configured bank — the "Import Brain"
 *  dialog's submit action. Success can add or wipe-and-replace bank content,
 *  so it resyncs the whole memory view the same way a global preference add
 *  does. */
export function useImportMemoryBrain() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (args: { file: File; mode: MemoryImportMode }) => importMemoryBrain(args.file, args.mode),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['memory'] })
    },
  })
}

import { BrainCog, Database, Download, LoaderCircle, MessageCircleQuestion, Upload, Waypoints } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { DataError } from '@/features/screens/DataError'
import { DataLoading } from '@/features/screens/DataLoading'
import { ModuleHeader } from '@/features/modules/ModuleHeader'
import { pickSaveTarget, SAVE_CANCELLED } from '@/lib/saveFile'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { ImportBrainDialog } from './ImportBrainDialog'
import { MemoryAsk } from './MemoryAsk'
import { MemoryBrowse } from './MemoryBrowse'
import { MemoryGraph } from './MemoryGraph'
import { MemoryOverview } from './MemoryOverview'
import { useExportMemoryBrain, useMemoryConfig } from './useMemory'

type Tab = 'overview' | 'browse' | 'graph' | 'ask'

const TABS: { id: Tab; label: string; Icon: LucideIcon }[] = [
  { id: 'overview', label: 'Overview', Icon: Database },
  { id: 'browse', label: 'Browse', Icon: BrainCog },
  { id: 'graph', label: 'Graph', Icon: Waypoints },
  { id: 'ask', label: 'Ask', Icon: MessageCircleQuestion },
]

/** The name offered in the save dialog. The server sends the real one back in
 *  Content-Disposition, but the dialog has to open *before* the export request
 *  (see runExport), so this stands in — the user can edit it in the panel
 *  anyway, and .zip is what the brain export always is. */
const BRAIN_EXPORT_NAME = 'memory-brain.zip'

/**
 * Persistent agent memory — one Hindsight-backed bank shared across every
 * project and every machine on this dashboard. See domain.MemoryConfig's doc
 * comment on the Go side for why this is hub-only and why it's tags on one
 * bank rather than a bank per project.
 */
export function MemoryModule() {
  const [tab, setTab] = useState<Tab>('overview')
  const [importOpen, setImportOpen] = useState(false)
  const config = useMemoryConfig()
  const openSettings = useDevDeckStore((s) => s.openDesktopSettings)
  const showToast = useDevDeckStore((s) => s.showToast)
  const exportBrain = useExportMemoryBrain()

  if (config.isPending) return <DataLoading label="loading memory config…" />
  if (config.isError) return <DataError error={config.error} onRetry={() => config.refetch()} />

  const configured = config.data.configured && config.data.enabled

  async function runExport() {
    // Destination first, bytes second. The browser's showSaveFilePicker needs
    // the click's transient activation, which is long gone by the time a brain
    // export finishes — asking afterwards would throw and silently dump the
    // file into Downloads instead of asking where it should go.
    const saveTarget = await pickSaveTarget(BRAIN_EXPORT_NAME)
    if (saveTarget === SAVE_CANCELLED) return
    try {
      const { blob } = await exportBrain.mutateAsync()
      await saveTarget.write(blob)
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Export failed')
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ModuleHeader
        title="Memory"
        meta={configured ? `bank: ${config.data.bankId}` : 'not configured'}
        actions={
          <div className="flex items-center gap-2">
            {configured && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void runExport()}
                  disabled={exportBrain.isPending}
                  title="Download this bank's full content as a transfer ZIP"
                >
                  {exportBrain.isPending ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} />}
                  Export Brain
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setImportOpen(true)}
                  title="Import a brain export from another machine or cloud"
                >
                  <Upload size={13} />
                  Import Brain
                </Button>
              </>
            )}
            <Button variant="secondary" size="sm" onClick={openSettings}>
              Settings
            </Button>
          </div>
        }
      />
      <ImportBrainDialog open={importOpen} onOpenChange={setImportOpen} />
      {!configured ? (
        <EmptyState onOpenSettings={openSettings} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex flex-none items-center gap-1 border-b border-devdeck-border px-3 py-1.5">
            {TABS.map((t) => {
              const active = tab === t.id
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  aria-current={active ? 'page' : undefined}
                  className={
                    'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors ' +
                    (active
                      ? 'bg-devdeck-on text-devdeck-fg'
                      : 'text-devdeck-fg-2 hover:bg-devdeck-hover-wash hover:text-devdeck-fg')
                  }
                >
                  <t.Icon size={14} strokeWidth={active ? 2.2 : 1.9} />
                  {t.label}
                </button>
              )
            })}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'overview' && <MemoryOverview />}
            {tab === 'browse' && <MemoryBrowse />}
            {tab === 'graph' && <MemoryGraph />}
            {tab === 'ask' && <MemoryAsk />}
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyState({ onOpenSettings }: { onOpenSettings: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-[420px] flex-col items-center gap-3.5 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-devdeck-accent-tint text-devdeck-accent">
          <BrainCog size={26} strokeWidth={1.6} />
        </div>
        <div className="text-[14px] font-semibold text-devdeck-fg">Persistent memory isn&rsquo;t configured yet</div>
        <p className="text-[12.5px] leading-relaxed text-devdeck-fg-2">
          Point DevDeck at a self-hosted Hindsight server to give every agent — every provider, every
          runtime, every project on this dashboard — one shared memory that survives across sessions.
        </p>
        <Button onClick={onOpenSettings} className="mt-1">
          Open Settings → Memory
        </Button>
      </div>
    </div>
  )
}

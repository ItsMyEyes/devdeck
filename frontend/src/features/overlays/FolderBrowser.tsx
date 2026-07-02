import { ChevronRight, CornerLeftUp, Folder, FolderTree, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ApiError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogTitle } from '@/components/ui/dialog'
import { useFsList } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

export function FolderBrowser() {
  const browse = useLoomStore((s) => s.browse)
  const closeBrowse = useLoomStore((s) => s.closeBrowse)
  const enterFolder = useLoomStore((s) => s.enterFolder)
  const browseUp = useLoomStore((s) => s.browseUp)
  const browseTo = useLoomStore((s) => s.browseTo)
  const useFolder = useLoomStore((s) => s.useFolder)

  const pathLabel = '~' + (browse.path.length ? '/' + browse.path.join('/') : '')
  const { data, isLoading, error, refetch } = useFsList(pathLabel)
  const folders = data?.entries ?? []
  const currentGit = data?.git ?? false
  const crumbs = ['~', ...browse.path]

  function renderContent() {
    if (isLoading) {
      return (
        <div className="flex h-[120px] items-center justify-center">
          <Loader2 size={22} strokeWidth={1.5} className="animate-spin text-loom-dim-2" />
        </div>
      )
    }

    if (error) {
      const msg = error instanceof ApiError ? error.message : 'Failed to read directory'
      return (
        <div className="flex h-[120px] flex-col items-center justify-center gap-3 px-4">
          <span className="text-center font-mono text-xs text-loom-dim-2">{msg}</span>
          <Button variant="secondary" size="sm" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      )
    }

    return (
      <>
        {browse.path.length > 0 && (
          <button
            onClick={browseUp}
            type="button"
            className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 text-left font-mono text-[12.5px] text-loom-muted hover:bg-loom-hover-wash"
          >
            <CornerLeftUp size={14} className="w-4 text-loom-dim" />
            ..
          </button>
        )}
        {folders.map((f) => (
          <button
            key={f.name}
            onClick={() => enterFolder(f.name)}
            type="button"
            className="flex h-[38px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 text-left hover:bg-loom-hover-wash"
          >
            <Folder size={15} className="w-4 text-[#e0b454]" />
            <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-loom-fg-2">{f.name}</span>
            {f.git && (
              <span className="rounded-[5px] border border-[#244029] bg-[#16221a] px-1.5 py-0.5 font-mono text-[9.5px] text-loom-green-soft">
                git
              </span>
            )}
            <ChevronRight size={13} className="text-loom-dim-3" />
          </button>
        ))}
        {folders.length === 0 && (
          <div className="flex h-[120px] items-center justify-center font-mono text-xs text-loom-dim-2">empty folder</div>
        )}
      </>
    )
  }

  return (
    <Dialog
      open={browse.open}
      onOpenChange={(o) => !o && closeBrowse()}
      width={520}
      z={65}
      className="flex h-[min(540px,86vh)] flex-col overflow-hidden !p-0"
    >
      {/* header */}
      <div className="flex-none border-b border-loom-border px-[18px] pb-3 pt-[17px]">
        <div className="mb-3 flex items-center gap-2.5">
          <FolderTree size={16} className="text-loom-muted" />
          <DialogTitle className="text-[14.5px]">Choose a folder</DialogTitle>
        </div>
        <div className="flex flex-wrap items-center gap-[3px] font-mono text-xs">
          {crumbs.map((name, i) => {
            const last = i === crumbs.length - 1
            return (
              <span key={i} className="flex items-center gap-[3px]">
                <button
                  onClick={() => browseTo(i)}
                  type="button"
                  className={cn('cursor-pointer px-0.5 hover:text-loom-accent-soft', last ? 'text-loom-fg-2' : 'text-loom-muted-2')}
                >
                  {name}
                </button>
                {!last && <span className="text-loom-dim-3">/</span>}
              </span>
            )
          })}
        </div>
      </div>

      {/* list */}
      <div className="flex-1 overflow-auto px-2.5 py-[7px]">
        {renderContent()}
      </div>

      {/* footer */}
      <div className="flex flex-none items-center gap-3 border-t border-loom-border bg-loom-surface px-[18px] py-3">
        <div className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-loom-muted">
          {pathLabel}
          {currentGit && <span className="text-loom-green-soft"> · git repo</span>}
        </div>
        <Button variant="secondary" onClick={closeBrowse}>
          Cancel
        </Button>
        <Button onClick={useFolder}>Use this folder</Button>
      </div>
    </Dialog>
  )
}

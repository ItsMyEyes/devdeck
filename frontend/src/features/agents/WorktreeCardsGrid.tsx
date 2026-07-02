import { Plus } from 'lucide-react'
import type { Project } from '@/store/types'
import { WorktreeCard } from './WorktreeCard'
import { ProjectEmpty } from '@/features/screens/ProjectEmpty'
import { useSettings } from '@/features/data/queries'
import { useLoomStore } from '@/store/useLoomStore'

export function WorktreeCardsGrid({ project, wsId }: { project: Project; wsId: string }) {
  const openSpawn = useLoomStore((s) => s.openSpawn)
  const defaultModel = useSettings().data?.defaultModel ?? 'claude-sonnet-5'
  const hasCards = project.worktrees.length > 0

  if (!hasCards) {
    return <ProjectEmpty onSpawn={() => openSpawn(project.id, 'branch', defaultModel)} />
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      <div
        className="grid content-start justify-start gap-3.5"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 380px))' }}
      >
        {project.worktrees.map((w) => (
          <WorktreeCard key={w.id} worktree={w} wsId={wsId} projectId={project.id} />
        ))}

        <button
          onClick={() => openSpawn(project.id, 'branch', defaultModel)}
          className="flex min-h-[160px] cursor-pointer flex-col items-center justify-center gap-2.5 rounded-[13px] border border-dashed border-loom-border-menu font-mono text-[12px] text-loom-dim hover:border-[#3a4254] hover:text-loom-muted"
        >
          <Plus size={26} strokeWidth={1.5} />
          <span>new worktree</span>
        </button>
      </div>
    </div>
  )
}

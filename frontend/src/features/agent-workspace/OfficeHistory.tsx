import { useState } from 'react'
import { SideDrawer } from '@/components/ui/drawer'
import { DialogTitle, DialogDescription } from '@/components/ui/dialog'
import {
  divisionOf,
  floorLabels,
  deskGroupLabel,
} from '@/features/agent-workspace/model'
import type { OfficeMember } from '@/features/agent-workspace/model'
import type { Workspace } from '@/store/types'

export function OfficeHistory({
  open,
  onOpenChange,
  members,
  workspace,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  members: OfficeMember[]
  workspace: Workspace
  onSelect: (member: OfficeMember) => void
}) {
  const [search, setSearch] = useState('')
  const [division, setDivision] = useState('all')
  const [group, setGroup] = useState('all')
  const archived = members.filter((m) => !!m.archivedAt)
  const parents = [
    ...new Set(
      archived.filter((m) => m.connectionId).map((m) => m.parentProject || ''),
    ),
  ].sort()
  const groups = [
    ...new Set(
      archived.map((m) =>
        m.connectionId
          ? `vm:${m.connectionId}`
          : `project:${m.projectId || ''}`,
      ),
    ),
  ].sort()
  const label = (m: OfficeMember) =>
    m.connectionId
      ? deskGroupLabel(m)
      : workspace.projects.find((p) => p.id === m.projectId)?.name ||
        'Developer'
  const shown = archived
    .filter(
      (m) =>
        (division === 'all' || divisionOf(m) === division) &&
        (group === 'all' ||
          (m.connectionId && group === `parent:${m.parentProject || ''}`) ||
          group ===
            (m.connectionId
              ? `vm:${m.connectionId}`
              : `project:${m.projectId || ''}`)) &&
        `${m.characterName || ''} ${m.title} ${label(m)}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort(
      (a, b) =>
        (b.archivedAt || 0) - (a.archivedAt || 0) || a.key.localeCompare(b.key),
    )
  return (
    <SideDrawer
      open={open}
      onOpenChange={onOpenChange}
      width={440}
      modal={false}
    >
      <div className="office-history-panel">
        <DialogTitle>Riwayat sesi</DialogTitle>
        <DialogDescription>
          Percakapan yang diakhiri tetap tersimpan. Membaca riwayat tidak
          menjalankan agent.
        </DialogDescription>
        <label>
          Cari riwayat
          <input value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label>
          Divisi riwayat
          <select
            value={division}
            onChange={(e) => setDivision(e.target.value)}
          >
            <option value="all">Semua divisi</option>
            <option value="developer">Developer</option>
            <option value="devops">DevOps</option>
          </select>
        </label>
        <label>
          Project / VM riwayat
          <select value={group} onChange={(e) => setGroup(e.target.value)}>
            <option value="all">Semua project / VM</option>
            {parents.map((parent) => (
              <option key={`parent:${parent}`} value={`parent:${parent}`}>
                {parent || 'Tanpa project'}
              </option>
            ))}
            {groups.map((g) => (
              <option key={g} value={g}>
                {label(
                  archived.find(
                    (m) =>
                      (m.connectionId
                        ? `vm:${m.connectionId}`
                        : `project:${m.projectId || ''}`) === g,
                  )!,
                )}
              </option>
            ))}
          </select>
        </label>
        <div className="office-roster">
          {shown.map((m) => (
            <button
              className="office-member-main"
              key={m.key}
              onClick={() => {
                onSelect(m)
                onOpenChange(false)
              }}
            >
              <span>
                <strong>
                  {m.characterName || 'Agent'} · {m.title || 'Untitled session'}
                </strong>
                <small>
                  {floorLabels[divisionOf(m)]} · {label(m)} · Diakhiri{' '}
                  {new Date(m.archivedAt!).toLocaleString()}
                </small>
              </span>
            </button>
          ))}
        </div>
        {!shown.length && (
          <p className="office-note">Tidak ada riwayat sesi yang cocok.</p>
        )}
        <button className="office-button" onClick={() => onOpenChange(false)}>
          Tutup riwayat
        </button>
      </div>
    </SideDrawer>
  )
}

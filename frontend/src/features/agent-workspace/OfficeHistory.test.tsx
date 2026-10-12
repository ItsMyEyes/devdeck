import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { OfficeHistory } from './OfficeHistory'
import type { OfficeMember } from './model'
import type { Workspace } from '@/store/types'
vi.mock('@/features/browser/useNativeOverlayBlocker', () => ({
  useNativeOverlayBlocker: vi.fn(),
}))
afterEach(cleanup)
it('filters archived sessions by division, parent category, saved VM and name', () => {
  const members = [
    {
      key: 'a',
      id: 'a',
      characterName: 'Arka Wijaya',
      title: 'Review',
      connectionId: 'vm1',
      hostName: 'First VM',
      parentProject: 'AIGN',
      archivedAt: 100,
    },
    {
      key: 'b',
      id: 'b',
      characterName: 'Dinda Putri',
      title: 'Deploy',
      connectionId: 'vm2',
      hostName: 'Second VM',
      parentProject: 'AIGN',
      archivedAt: 200,
    },
    {
      key: 'c',
      id: 'c',
      characterName: 'Fajar Santoso',
      title: 'Local tests',
      projectId: 'p',
      archivedAt: 300,
    },
    { key: 'live', id: 'live', title: 'Live session', archivedAt: 0 },
  ] as OfficeMember[]
  const pick = vi.fn()
  render(
    <OfficeHistory
      open
      onOpenChange={vi.fn()}
      members={members}
      workspace={{ projects: [{ id: 'p', name: 'DevDeck' }] } as Workspace}
      onSelect={pick}
    />,
  )
  expect(
    screen.queryByRole('button', { name: /Live session/ }),
  ).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Divisi riwayat'), {
    target: { value: 'devops' },
  })
  expect(
    screen.queryByRole('button', { name: /Local tests/ }),
  ).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Project / VM riwayat'), {
    target: { value: 'parent:AIGN' },
  })
  expect(screen.getAllByRole('button', { name: /Review|Deploy/ })).toHaveLength(
    2,
  )
  fireEvent.change(screen.getByLabelText('Project / VM riwayat'), {
    target: { value: 'vm:vm2' },
  })
  expect(
    screen.queryByRole('button', { name: /Review/ }),
  ).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Cari riwayat'), {
    target: { value: 'Dinda' },
  })
  fireEvent.click(screen.getByRole('button', { name: /Dinda Putri.*Deploy/ }))
  expect(pick).toHaveBeenCalledWith(members[1])
})

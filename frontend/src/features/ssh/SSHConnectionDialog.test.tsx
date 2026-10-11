import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import type { SSHConnection } from '@/store/types'
import { SSHConnectionDialog } from './SSHConnectionDialog'

const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), supported: true }))
vi.mock('@/features/browser/useNativeOverlayBlocker', () => ({ useNativeOverlayBlocker: vi.fn() }))
vi.mock('@/features/data/queries', () => ({
  useCreateSSHConnection: () => ({ mutate: mocks.create, isPending: false }),
  useUpdateSSHConnection: () => ({ mutate: mocks.update, isPending: false }),
  useMachines: () => ({ data: [] }),
  useMachinesHealth: () => new Map(),
  useSSHConnections: () => ({
    data: [{ id: 'vm-2', name: 'Second VM', group: 'production', parentProject: 'AIGN' }],
  }),
  useWhoami: () => ({ data: { capabilities: mocks.supported ? ['ssh-parent-project'] : [] } }),
}))
beforeEach(() => {
  mocks.supported = true
  mocks.create.mockClear()
  mocks.update.mockClear()
  useDevDeckStore.getState().openAddSSHConnection()
  useDevDeckStore
    .getState()
    .setSSHDialog({
      name: 'VM',
      host: 'localhost',
      username: 'dev',
      password: 'test',
      group: 'production',
    })
})
afterEach(() => {
  cleanup()
  useDevDeckStore.getState().closeSSHDialog()
})
it('saves the free-text parent independently of Group and suggests saved categories', () => {
  render(<SSHConnectionDialog />)
  fireEvent.focus(screen.getByLabelText('Parent project'))
  expect(screen.getByRole('button', { name: 'AIGN' })).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Parent project'), { target: { value: ' New project ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  expect(mocks.create.mock.calls[0][0]).toMatchObject({
    parentProject: 'New project',
    group: 'production',
  })
})
it('does not offer persistence that a legacy backend cannot support', () => {
  mocks.supported = false
  render(<SSHConnectionDialog />)
  expect(screen.getByLabelText('Parent project')).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Add' }))
  expect(mocks.create.mock.calls[0][0]).not.toHaveProperty('parentProject')
})

it('edits and clears the saved parent without changing Group', () => {
  useDevDeckStore.getState().openEditSSHConnection({id:'vm',name:'VM',host:'localhost',port:22,username:'dev',authType:'password',group:'production',parentProject:'AIGN'} as SSHConnection)
  render(<SSHConnectionDialog />)
  expect(screen.getByLabelText('Parent project')).toHaveValue('AIGN')
  fireEvent.change(screen.getByLabelText('Parent project'),{target:{value:''}})
  fireEvent.click(screen.getByRole('button',{name:'Save'}))
  expect(mocks.update.mock.calls[0][0]).toMatchObject({id:'vm',patch:{parentProject:'',group:'production'}})
})

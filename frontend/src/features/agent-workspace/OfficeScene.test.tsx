vi.mock('@/features/agent-workspace/OfficeInterior', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  FurnitureModel: ({ children }: { children: ReactNode }) => <>{children}</>,
  ContactShade: () => null,
}))
vi.mock('@/features/agent-workspace/OfficeEffects', () => ({
  default: () => null,
}))
vi.mock('@/features/agent-workspace/OfficeHtml', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  OfficeLabelManager: () => null,
}))
import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import OfficeScene from '@/features/agent-workspace/OfficeScene'
import type { OfficeMember } from '@/features/agent-workspace/model'
vi.mock('@/features/agent-workspace/OfficeEnvironment', () => ({
  default: () => null,
  OfficeLighting: () => null,
  QualityMonitor: () => null,
}))
const settings = vi.hoisted(() => ({ reduced: false, frameloop: '' }))
vi.mock('motion/react', () => ({ useReducedMotion: () => settings.reduced }))
vi.mock('@react-three/fiber', () => ({
  Canvas: ({
    children,
    frameloop,
  }: {
    children: ReactNode
    frameloop: string
  }) => {
    settings.frameloop = frameloop
    return <>{children}</>
  },
  useFrame: vi.fn(),
}))
vi.mock('@react-three/drei', () => ({
  Html: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('@/features/agent-workspace/OfficeCamera', () => ({
  default: () => null,
}))
vi.mock('@/features/agent-workspace/OfficeActor', () => ({
  default: ({ member }: { member: OfficeMember }) => (
    <span>{member.characterName}</span>
  ),
}))
afterEach(cleanup)
it('renders a saved VM group using composite backend/session identity', () => {
  const member: OfficeMember = {
    sourceId: 'runtime',
    sourceName: 'Runtime',
    limited: false,
    title: 'Chat',
    agent: 'claude',
    model: '',
    turnInFlight: false,
    approvals: 0,
    questions: 0,
    planReady: false,
    activity: '',
    updatedAt: 1,
    key: '["runtime","ssh:vm",""]',
    id: 'ssh:vm',
    connectionId: 'vm',
    parentProject: 'AIGN',
    hostName: 'First VM',
    characterName: 'Arka Wijaya',
    status: 'idle',
    subagents: [],
    recent: [],
    stale: false,
  }
  render(
    <OfficeScene
      workspaceId="ws"
      view="devops"
      onViewChange={vi.fn()}
      members={[member]}
      allMembers={[member]}
      projects={[]}
      focusId={0}
      runtimeSummary=""
      visible
      reset={0}
      onSelect={vi.fn()}
      onModule={vi.fn()}
    />,
  )
  expect(screen.getByText('AIGN / First VM')).toBeInTheDocument()
  expect(screen.getByText('Arka Wijaya')).toBeInTheDocument()
})

it('stops hidden rendering and uses static demand rendering with reduced motion', () => {
  const props = {
    workspaceId: 'ws',
    view: 'developer' as const,
    onViewChange: vi.fn(),
    members: [],
    allMembers: [],
    projects: [],
    focusId: 0,
    runtimeSummary: '',
    visible: false,
    reset: 0,
    onSelect: vi.fn(),
    onModule: vi.fn(),
  }
  const scene = render(<OfficeScene {...props} />)
  expect(settings.frameloop).toBe('never')
  scene.rerender(<OfficeScene {...props} visible />)
  expect(settings.frameloop).toBe('always')
  expect(
    screen.queryByRole('combobox', { name: 'Office environment' }),
  ).not.toBeInTheDocument()
  settings.reduced = true
  scene.rerender(<OfficeScene {...props} visible />)
  expect(settings.frameloop).toBe('demand')
  settings.reduced = false
})

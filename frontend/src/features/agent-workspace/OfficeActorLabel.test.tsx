import { afterEach, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ReactNode } from 'react'
import OfficeActorLabel from '@/features/agent-workspace/OfficeActorLabel'
import type { OfficeMember } from '@/features/agent-workspace/model'
vi.mock('@/features/agent-workspace/OfficeHtml', () => ({
  default: ({
    children,
    priority,
  }: {
    children: ReactNode
    priority: number
  }) => (
    <div data-testid="label" data-priority={priority}>
      {children}
    </div>
  ),
}))
afterEach(cleanup)
it('shows actual work and participates in collision layout when the DOM status dot is hovered', () => {
  const member = {
    key: 'parent',
    characterName: 'Arka',
    title: 'Fix',
    agent: 'codex',
    status: 'running',
    turnInFlight: true,
    subagents: [],
    work: { kind: 'command', activeCount: 2, coverage: 'item_lifecycle' },
  } as unknown as OfficeMember
  const onSelect = vi.fn()
  render(
    <OfficeActorLabel
      member={member}
      selected={false}
      completed={false}
      onSelect={onSelect}
    />,
  )
  const button = screen.getByRole('button')
  expect(screen.queryByText(/Running a command/)).not.toBeInTheDocument()
  fireEvent.pointerEnter(button)
  expect(screen.getByText(/Running a command/)).toHaveTextContent(
    'Running a command · 2',
  )
  expect(screen.getByTestId('label')).toHaveAttribute('data-priority', '2')
  fireEvent.click(button)
  expect(onSelect).toHaveBeenCalledWith(member, undefined)
  fireEvent.pointerLeave(button)
  expect(screen.queryByText(/Running a command/)).not.toBeInTheDocument()
})

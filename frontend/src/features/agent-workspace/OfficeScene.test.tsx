import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import OfficeScene from './OfficeScene'
import type { OfficeMember } from './model'
vi.mock('@react-three/fiber', () => ({Canvas:({children}:{children:ReactNode})=><>{children}</>,useFrame:vi.fn()}))
vi.mock('@react-three/drei', () => ({Html:({children}:{children:ReactNode})=><>{children}</>}))
vi.mock('./OfficeCamera', () => ({default:()=>null}))
afterEach(cleanup)
it('renders a saved VM group using composite backend/session identity', () => {
  const member: OfficeMember = {sourceId:'runtime',sourceName:'Runtime',limited:false,title:'Chat',agent:'claude',model:'',turnInFlight:false,approvals:0,questions:0,planReady:false,activity:'',updatedAt:1,key:'["runtime","ssh:vm",""]',id:'ssh:vm',connectionId:'vm',parentProject:'AIGN',hostName:'First VM',characterName:'Arka Wijaya',status:'idle',subagents:[],recent:[],stale:false}
  render(<OfficeScene workspaceId="ws" view="devops" onViewChange={vi.fn()} members={[member]} allMembers={[member]} projects={[]} focusId={0} runtimeSummary="" visible reset={0} onSelect={vi.fn()} onModule={vi.fn()} />)
  expect(screen.getByText('AIGN / First VM')).toBeInTheDocument()
  expect(screen.getByText('Arka Wijaya')).toBeInTheDocument()
})

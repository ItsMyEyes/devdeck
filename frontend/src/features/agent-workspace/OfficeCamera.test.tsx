import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { PerspectiveCamera, Vector3 } from 'three'
import OfficeCamera from '@/features/agent-workspace/OfficeCamera'
const mocks = vi.hoisted(() => ({
  camera: null as unknown as PerspectiveCamera,
  controls: null as unknown as { target: Vector3; update: () => void },
  invalidate: vi.fn(),
  frame: null as null | (() => void),
  onStart: null as null | (() => void),
}))
vi.mock('@react-three/fiber', () => ({
  useFrame: (callback: () => void) => {
    mocks.frame = callback
  },
  useThree: () => ({ camera: mocks.camera, invalidate: mocks.invalidate }),
}))
vi.mock('@react-three/drei', async () => {
  const { forwardRef, useImperativeHandle } = await import('react')
  return {
    OrbitControls: forwardRef((props: { onStart?: () => void }, ref) => {
      mocks.onStart = props.onStart || null
      useImperativeHandle(ref, () => mocks.controls)
      return null
    }),
  }
})
beforeEach(() => {
  localStorage.clear()
  mocks.camera = new PerspectiveCamera()
  mocks.controls = { target: new Vector3(), update: vi.fn() }
})
afterEach(cleanup)
const props = {
  workspaceId: 'ws',
  view: 'building' as const,
  center: [0, 2.5, 0] as [number, number, number],
  span: 20,
  reset: 0,
  action: { id: 0, type: '' },
  mode: 'pan' as const,
  focusId: 0,
}
it('restores cameras independently and resets only the currently viewed floor', () => {
  const building = { position: [10, 15, 20], target: [1, 2.5, 3] }
  const devops = { position: [20, 25, 30], target: [2, 5, 4] }
  localStorage.setItem(
    'devdeck.office-camera.ws.building',
    JSON.stringify(building),
  )
  localStorage.setItem(
    'devdeck.office-camera.ws.devops',
    JSON.stringify(devops),
  )
  const { rerender } = render(<OfficeCamera {...props} />)
  expect(mocks.camera.position.toArray()).toEqual(building.position)
  rerender(<OfficeCamera {...props} view="devops" center={[0, 5, 0]} />)
  expect(mocks.camera.position.toArray()).toEqual(devops.position)
  rerender(
    <OfficeCamera {...props} view="devops" center={[0, 5, 0]} reset={1} />,
  )
  expect(mocks.controls.target.y).toBe(5)
  expect(mocks.camera.position.y).toBe(23)
  expect(
    JSON.parse(localStorage.getItem('devdeck.office-camera.ws.building')!),
  ).toEqual(building)
  rerender(<OfficeCamera {...props} reset={1} />)
  expect(mocks.camera.position.toArray()).toEqual(building.position)
})
it('does not replay a camera action or refocus the selected session on a manual floor change', () => {
  const saved = { position: [10, 15, 20], target: [1, 2.5, 3] }
  localStorage.setItem(
    'devdeck.office-camera.ws.building',
    JSON.stringify(saved),
  )
  const { rerender } = render(<OfficeCamera {...props} />)
  rerender(
    <OfficeCamera
      {...props}
      view="devops"
      center={[0, 5, 0]}
      selected={[2, 5, 3]}
      focusId={1}
      action={{ id: 1, type: 'right' }}
    />,
  )
  expect(mocks.controls.target.y).toBe(5)
  rerender(
    <OfficeCamera
      {...props}
      selected={[2, 5, 3]}
      focusId={1}
      action={{ id: 1, type: 'right' }}
    />,
  )
  expect(mocks.camera.position.toArray()).toEqual(saved.position)
  expect(mocks.controls.target.toArray()).toEqual(saved.target)
})
it('ignores corrupt storage and keeps the current pose during status/layout updates', () => {
  localStorage.setItem('devdeck.office-camera.ws.building', '{bad')
  const { rerender } = render(<OfficeCamera {...props} />)
  const pose = mocks.camera.position.toArray()
  rerender(<OfficeCamera {...props} span={50} center={[10, 2.5, 10]} />)
  expect(mocks.camera.position.toArray()).toEqual(pose)
})

it('restores a saved pose on remount without repeating selection or movement', () => {
  const saved = { position: [10, 15, 20], target: [1, 2.5, 3] }
  localStorage.setItem(
    'devdeck.office-camera.ws.building',
    JSON.stringify(saved),
  )
  render(
    <OfficeCamera
      {...props}
      selected={[8, 0, 9]}
      focusId={2}
      action={{ id: 3, type: 'right' }}
    />,
  )
  expect(mocks.camera.position.toArray()).toEqual(saved.position)
  expect(mocks.controls.target.toArray()).toEqual(saved.target)
})

it('saves a newly focused session as the floor camera preference', () => {
  const { rerender } = render(<OfficeCamera {...props} />)
  rerender(
    <OfficeCamera
      {...props}
      view="devops"
      center={[0, 5, 0]}
      selected={[2, 5, 3]}
      focusId={1}
    />,
  )
  expect(
    JSON.parse(localStorage.getItem('devdeck.office-camera.ws.devops')!),
  ).toMatchObject({ target: [2, 5, 3] })
})

it('follows the live selected position and cancels for manual navigation', () => {
  const onFollowChange = vi.fn()
  let position: [number, number, number] = [1, 0, 1]
  render(
    <OfficeCamera
      {...props}
      follow
      visible
      onFollowChange={onFollowChange}
      getSelected={() => position}
    />,
  )
  mocks.frame?.()
  const before = mocks.controls.target.clone()
  position = [5, 0, 5]
  mocks.frame?.()
  expect(mocks.controls.target.x).toBeGreaterThan(before.x)
  mocks.onStart?.()
  expect(onFollowChange).toHaveBeenCalledWith(false)
})
it('cancels follow when reset is requested', () => {
  const onFollowChange = vi.fn()
  const { rerender } = render(
    <OfficeCamera {...props} follow onFollowChange={onFollowChange} />,
  )
  onFollowChange.mockClear()
  rerender(
    <OfficeCamera
      {...props}
      reset={1}
      follow
      onFollowChange={onFollowChange}
    />,
  )
  expect(onFollowChange).toHaveBeenCalledWith(false)
})

it('extends the existing projection when a growing office enlarges its exterior', () => {
  mocks.camera.far = 500
  mocks.camera.updateProjectionMatrix()
  const { rerender } = render(<OfficeCamera {...props} far={500} />)
  const before = mocks.camera.projectionMatrix.elements.slice()
  rerender(<OfficeCamera {...props} far={1200} />)
  expect(mocks.camera.far).toBe(1200)
  expect(mocks.camera.projectionMatrix.elements).not.toEqual(before)
})

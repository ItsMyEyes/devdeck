import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Group, PerspectiveCamera, Scene } from 'three'
import {
  officeLabelsFor,
  OfficeLabelManager,
} from '@/features/agent-workspace/OfficeHtml'
const mocks = vi.hoisted(() => ({
  state: {} as unknown,
  frame: null as null | ((state: unknown, delta: number) => void),
}))
vi.mock('@react-three/fiber', () => ({
  useThree: () => mocks.state,
  useFrame: (callback: typeof mocks.frame) => {
    mocks.frame = callback
  },
}))
let host: HTMLDivElement, camera: PerspectiveCamera
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  camera = new PerspectiveCamera(38, 1, 0.1, 100)
  camera.position.set(0, 6, 10)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  mocks.state = {
    gl: { domElement: { parentElement: host } },
    camera,
    scene: new Scene(),
    size: { width: 500, height: 500 },
    frameloop: 'demand',
  }
})
afterEach(() => {
  cleanup()
  host.remove()
})
function label(priority: number) {
  const element = document.createElement('div'),
    group = new Group()
  group.position.x = 2
  host.append(element)
  officeLabelsFor(host).add({
    id: 'detail',
    element,
    group,
    priority,
    kind: 'zone',
    center: true,
  })
  return element
}
it('projects labels on the final demand-rendered camera frame without waiting for another frame', () => {
  const element = label(3)
  render(<OfficeLabelManager view="developer" />)
  mocks.frame?.({}, 0.1)
  const before = element.style.transform
  camera.position.x = 4
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld()
  mocks.frame?.({}, 0.01)
  expect(element.style.transform).not.toBe(before)
})
it('retains selected task details in Building while suppressing ordinary zones', () => {
  const element = label(3)
  render(<OfficeLabelManager view="building" />)
  mocks.frame?.({}, 0.1)
  expect(element.style.visibility).not.toBe('hidden')
})

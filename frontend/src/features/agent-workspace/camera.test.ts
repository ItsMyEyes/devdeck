import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import {
  applyCameraAction,
  officeCameraOffset,
} from '@/features/agent-workspace/camera'

describe('office camera movement', () => {
  it('frames both floors and lounge without clipping corners in a narrow workspace viewport', () => {
    const camera = new PerspectiveCamera(38, 1.27, 0.1, 1000)
    camera.position.copy(
      officeCameraOffset([21, 8.5, 29], camera.fov, camera.aspect),
    )
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()
    for (const x of [-10.5, 10.5])
      for (const y of [-4.25, 4.25])
        for (const z of [-14.5, 14.5]) {
          const point = new Vector3(x, y, z).project(camera)
          expect(Math.abs(point.x)).toBeLessThanOrEqual(0.91)
          expect(Math.abs(point.y)).toBeLessThanOrEqual(0.91)
        }
  })
  it('slides right without changing camera height, viewing angle or zoom', () => {
    const camera = new PerspectiveCamera()
    camera.position.set(0, 6, 8)
    const target = new Vector3()
    applyCameraAction(camera, target, 'right')
    expect(camera.position.x).toBeCloseTo(0.8)
    expect(camera.position.y).toBe(6)
    expect(camera.position.z).toBe(8)
    expect(target.toArray()).toEqual([0.8, 0, 0])
  })
  it('uses the current viewing direction after rotating the office', () => {
    const camera = new PerspectiveCamera()
    camera.position.set(8, 6, 0)
    const target = new Vector3()
    applyCameraAction(camera, target, 'right')
    expect(camera.position.toArray()).toEqual([8, 6, -0.8])
    expect(target.toArray()).toEqual([0, 0, -0.8])
  })
  it('moves forward and back along the floor', () => {
    const camera = new PerspectiveCamera()
    camera.position.set(0, 6, 8)
    const target = new Vector3()
    applyCameraAction(camera, target, 'up')
    expect(target.toArray()).toEqual([0, 0, -0.8])
    applyCameraAction(camera, target, 'down')
    expect(target.length()).toBeCloseTo(0)
    expect(camera.position.toArray()).toEqual([0, 6, 8])
  })
})

import { describe, expect, it } from 'vitest'
import { PerspectiveCamera, Vector3 } from 'three'
import { applyCameraAction } from '@/features/agent-workspace/camera'

describe('office camera movement', () => {
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

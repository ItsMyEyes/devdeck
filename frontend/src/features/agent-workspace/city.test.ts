import { describe, expect, it } from 'vitest'
import {
  createCity,
  fitCity,
  CityMotion,
  trafficVisible,
} from '@/features/agent-workspace/city'
import { createCityScene } from '@/features/agent-workspace/cityRenderer'
import { InstancedMesh, Vector3, Matrix4 } from 'three'

describe('Kantor AI exterior', () => {
  it('keeps the seeded reference city stable across remounts', () => {
    const a = createCity(),
      b = createCity()
    expect(a).toEqual(b)
    expect(a.buildings).toHaveLength(64)
    expect(a.traffic).toHaveLength(20)
    expect(a.clouds).toHaveLength(12)
    expect(a.birds).toHaveLength(8)
    expect(new Set(a.traffic.map((v) => v.kind))).toEqual(
      new Set(['car', 'bus', 'bike']),
    )
    // Source excludes the office lawn and both streets from generated blocks.
    for (const block of a.buildings) {
      expect(Math.abs(block.z - 24)).toBeGreaterThanOrEqual(block.depth / 2 + 6)
      expect(Math.abs(block.x - 34)).toBeGreaterThanOrEqual(block.width / 2 + 6)
      expect(
        block.x > -40 && block.x < 28 && block.z > -28 && block.z < 22,
      ).toBe(false)
    }
  })

  it('uniformly fits dense and empty offices inside the clear reference footprint', () => {
    for (const bounds of [
      { minX: -9, maxX: 9, minZ: -7, maxZ: 18 },
      { minX: -9, maxX: 42, minZ: -7, maxZ: 61 },
    ]) {
      const fit = fitCity(bounds)
      const transform = new Matrix4()
        .makeRotationY(fit.rotation)
        .scale(new Vector3(fit.scale, fit.scale, fit.scale))
        .setPosition(fit.x, fit.y, fit.z)
      const corners = [
        [-23.3, -12.55],
        [-23.3, 12.55],
        [16.55, -12.55],
        [16.55, 12.55],
      ].map(([x, z]) => new Vector3(x, 0, z).applyMatrix4(transform))
      expect(Math.min(...corners.map((p) => p.x))).toBeLessThanOrEqual(
        bounds.minX - 4,
      )
      expect(Math.max(...corners.map((p) => p.x))).toBeGreaterThanOrEqual(
        bounds.maxX + 4,
      )
      expect(Math.min(...corners.map((p) => p.z))).toBeLessThanOrEqual(
        bounds.minZ - 4,
      )
      expect(Math.max(...corners.map((p) => p.z))).toBeGreaterThanOrEqual(
        bounds.maxZ + 4,
      )
      expect(fit.far).toBeGreaterThan(200 * fit.scale)
    }
  })

  it('aligns the reference long axis with deep offices to avoid an oversized empty lawn', () => {
    const fit = fitCity({ minX: -9, maxX: 42, minZ: -7, maxZ: 61 })
    expect(fit.rotation).toBe(Math.PI / 2)
    expect(fit.scale).toBeCloseTo(59 / 25.1)
  })

  it('keeps vehicles in their source lanes at frame-rate-independent speeds', () => {
    const city = createCity(),
      motion = new CityMotion(city)
    const positions = city.traffic.map((v) => v.pos)
    for (let i = 0; i < 60; i++) motion.tick(1 / 60, true, false, 'balanced')
    motion.traffic.forEach((v, i) => {
      expect(v.pos - positions[i]).toBeCloseTo(8 + Math.floor(i / 5) * 0.8)
      expect(v.axis === 'x' ? v.z : v.x).toBe(v.fixed)
      expect(v.axis === 'x' ? v.x : v.z).toBeCloseTo(v.pos * v.direction)
    })
  })

  it('wraps at the city edge and preserves lane gaps', () => {
    const motion = new CityMotion(createCity())
    motion.traffic[0].pos = 134.99
    motion.tick(1 / 60, true, false, 'high')
    expect(motion.traffic[0].pos).toBe(-135)
    const gap = motion.traffic[2].pos - motion.traffic[1].pos
    for (let i = 0; i < 60; i++) motion.tick(1 / 60, true, false, 'high')
    expect(motion.traffic[2].pos - motion.traffic[1].pos).toBeCloseTo(gap)
  })

  it('keeps eight moving vehicles on Low without resetting hidden vehicle phases', () => {
    const motion = new CityMotion(createCity())
    expect(
      motion.traffic.filter((_, i) => trafficVisible(i, 'low')),
    ).toHaveLength(8)
    for (let lane = 0; lane < 4; lane++)
      expect(
        motion.traffic
          .slice(lane * 5, lane * 5 + 5)
          .filter((_, i) => trafficVisible(lane * 5 + i, 'low')),
      ).toHaveLength(2)
    const traffic = motion.traffic.map((v) => v.pos),
      bird = motion.birds[0].angle,
      cloud = motion.clouds[0].angle
    motion.tick(1 / 60, true, false, 'low')
    motion.traffic.forEach((v, i) => expect(v.pos).toBeGreaterThan(traffic[i]))
    expect(motion.birds[0].angle).toBe(bird)
    expect(motion.clouds[0].angle).toBe(cloud)
    const phase = motion.traffic[0].pos
    motion.tick(1 / 60, true, false, 'high')
    expect(motion.traffic[0].pos).toBeGreaterThan(phase)
    expect(motion.birds[0].angle).not.toBe(bird)
    expect(motion.clouds[0].angle).not.toBe(cloud)
  })

  it('freezes hidden and reduced scenes and ignores resume catch-up delta', () => {
    const motion = new CityMotion(createCity())
    const initial = JSON.stringify(motion)
    motion.tick(10, false, false, 'high')
    motion.tick(1 / 60, true, true, 'high')
    motion.tick(10, true, false, 'high')
    expect(JSON.stringify(motion)).toBe(initial)
    motion.tick(1 / 60, true, false, 'high')
    expect(JSON.stringify(motion)).not.toBe(initial)
  })

  it('renders batched traffic transforms and retains every lane on Low', () => {
    const city = createCity(),
      motion = new CityMotion(city),
      rendered = createCityScene(city)
    const boxes = rendered.group.getObjectByName(
      'city-vehicle-boxes',
    ) as InstancedMesh
    const before = Array.from(boxes.instanceMatrix.array)
    motion.tick(1 / 60, true, false, 'balanced')
    rendered.update(motion, 'balanced')
    expect(Array.from(boxes.instanceMatrix.array)).not.toEqual(before)
    rendered.update(motion, 'low')
    expect(rendered.group.userData.visibleVehicles).toBe(8)
    rendered.update(motion, 'high')
    expect(rendered.group.userData.visibleVehicles).toBe(20)
    let batches = 0
    rendered.group.traverse((o) => {
      if (o instanceof InstancedMesh) {
        batches++
        // Instance colors must not be multiplied by a missing vertex-color buffer.
        const materials = Array.isArray(o.material) ? o.material : [o.material]
        for (const material of materials)
          expect(
            material.vertexColors && !o.geometry.getAttribute('color'),
          ).toBe(false)
      }
    })
    expect(batches).toBeLessThan(12)
    rendered.dispose()
  })
})

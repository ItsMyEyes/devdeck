import { expect, it } from 'vitest'
import {
  Box3,
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  LinearFilter,
  LinearMipmapLinearFilter,
} from 'three'
import {
  texturePixels,
  interiorMaterial,
} from '@/features/agent-workspace/interiorMaterials'
import { normalizeFurniture } from '@/features/agent-workspace/interiorAssets'
import { facePose } from '@/features/agent-workspace/facePose'
import { placeLabels } from '@/features/agent-workspace/labelLayout'
import { qualitySettings } from '@/features/agent-workspace/sceneSettings'

it('generates repeatable textured surfaces without browser canvas or random state', () => {
  const a = texturePixels('wood', 32)
  expect(a).toEqual(texturePixels('wood', 32))
  expect(new Set(a).size).toBeGreaterThan(20)
  expect(a).not.toEqual(texturePixels('fabric', 32))
  expect(a.length).toBe(32 * 32 * 4)
  const full = texturePixels('wood', 256)
  expect(full.every((channel, i) => i % 4 === 3 || channel >= 120)).toBe(true)
})
it('filters repeating grain at distance instead of sampling noisy individual texels', () => {
  const m = interiorMaterial('#b58050', 'wood', 'low')
  expect(m.map?.minFilter).toBe(LinearMipmapLinearFilter)
  expect(m.map?.magFilter).toBe(LinearFilter)
})
it('fits a model to the existing furniture envelope and grounds its pivot', () => {
  const scene = new Group()
  const mesh = new Mesh(new BoxGeometry(2, 4, 6), new MeshStandardMaterial())
  mesh.position.set(3, 4, 5)
  scene.add(mesh)
  const result = normalizeFurniture(scene, [2.05, 0.965, 0.92])
  const bounds = new Box3().setFromObject(result)
  expect(bounds.min.y).toBeCloseTo(0)
  expect(bounds.getCenter(new Vector3()).x).toBeCloseTo(0)
  expect(bounds.getSize(new Vector3()).toArray()).toEqual(
    expect.arrayContaining([
      expect.closeTo(2.05),
      expect.closeTo(0.965),
      expect.closeTo(0.92),
    ]),
  )
  expect(new Box3().setFromObject(scene).min.y).toBe(2)
})
it('keeps static faces for reduced motion and Low without inventing speech', () => {
  expect(facePose('work', 42, 12, true)).toEqual(facePose('work', 42, 15, true))
  expect(facePose('unknown', 42, 15, false).brow).toBe(0)
  expect(facePose('error', 42, 15, false).brow).not.toBe(0)
  const eyes = Array.from(
    { length: 600 },
    (_, i) => facePose('work', 42, i / 100, false).eye,
  )
  expect(Math.min(...eyes)).toBeLessThan(0.2)
  expect(Math.max(...eyes)).toBe(1)
})
it('keeps selection visible while removing colliding zone labels', () => {
  const labels = [
    { id: 'zone', x: 50, y: 50, width: 80, height: 20, priority: 0 },
    { id: 'selected', x: 50, y: 50, width: 80, height: 20, priority: 3 },
    { id: 'hover', x: 50, y: 50, width: 80, height: 20, priority: 2 },
  ]
  const placed = placeLabels(labels, 300, 200)
  expect(placed.find((l) => l.id === 'selected')?.visible).toBe(true)
  expect(placed.find((l) => l.id === 'zone')?.visible).toBe(false)
  expect(placed.find((l) => l.id === 'hover')?.y).not.toBe(50)
})
it('limits heavy effects to High while retaining existing quality budgets', () => {
  expect(qualitySettings.high.ao).toBe(true)
  expect(qualitySettings.balanced.ao).toBe(false)
  expect(qualitySettings.low.normalMaps).toBe(false)
  expect(qualitySettings.high.textureSize).toBe(1024)
  expect(qualitySettings.balanced.textureSize).toBe(512)
  expect(qualitySettings.low.textureSize).toBe(256)
})

import { afterEach, expect, it, vi } from 'vitest'
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Vector3,
  Matrix4,
} from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { readFileSync } from 'node:fs'
import { Raycaster } from 'three'
import { FurnitureRegistry } from '@/features/agent-workspace/OfficeInterior'
afterEach(() => vi.restoreAllMocks())
it('aligns the actual bundled chair cushion with the existing seated contact surface', async () => {
  const bytes = Uint8Array.from(
    readFileSync('public/office-assets/furniture/chairDesk.glb'),
  )
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '')
  vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation((_url, loaded) => {
    loaded(gltf)
    return undefined as never
  })
  const registry = new FurnitureRegistry(vi.fn())
  registry.add('chair', {
    anchor: new Group(),
    size: [0.66, 1.2, 0.64],
    ready: vi.fn(),
  })
  await Promise.resolve()
  const shape = new Mesh(
    registry.batches[0].mesh.geometry,
    new MeshStandardMaterial(),
  )
  const hits = new Raycaster(
    new Vector3(0, 3, 0),
    new Vector3(0, -1, 0),
  ).intersectObject(shape)
  expect(hits[0].point.y).toBeCloseTo(0.55, 3)
  registry.dispose()
  ;(shape.material as MeshStandardMaterial).dispose()
})
it('instances shared furniture at parent transforms and removes unmounted entries', async () => {
  const source = new Group()
  source.add(
    new Mesh(
      new BoxGeometry(1, 1, 1),
      new MeshStandardMaterial({ color: '#aa7755' }),
    ),
  )
  vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation((_url, loaded) => {
    loaded({ scene: source } as never)
    return undefined as never
  })
  const registry = new FurnitureRegistry(vi.fn())
  const floor = new Group()
  floor.position.y = 5
  const anchor = new Group()
  anchor.position.set(2, 0, 3)
  floor.add(anchor)
  const ready = vi.fn()
  const remove = registry.add('desk', {
    anchor,
    size: [2.05, 0.965, 0.92],
    ready,
  })
  await Promise.resolve()
  expect(ready).toHaveBeenCalledWith(true)
  expect(registry.batches).toHaveLength(1)
  const matrix = new Matrix4()
  registry.batches[0].mesh.getMatrixAt(0, matrix)
  expect(new Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([
    2, 5, 3,
  ])
  const geometry = registry.batches[0].mesh.geometry
  const dispose = vi.spyOn(geometry, 'dispose')
  remove()
  await Promise.resolve()
  expect(registry.batches).toHaveLength(0)
  expect(dispose).toHaveBeenCalledOnce()
  registry.dispose()
})
it('coalesces a synchronous admission batch before rebuilding shared GPU buffers', async () => {
  const source = new Group()
  source.add(new Mesh(new BoxGeometry(), new MeshStandardMaterial()))
  vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation((_url, loaded) => {
    loaded({ scene: source } as never)
    return undefined as never
  })
  const registry = new FurnitureRegistry(vi.fn())
  const rebuild = vi.spyOn(registry, 'rebuild')
  for (let i = 0; i < 20; i++)
    registry.add('desk', {
      anchor: new Group(),
      size: [2, 1, 1],
      ready: vi.fn(),
    })
  await Promise.resolve()
  expect(rebuild).toHaveBeenCalledOnce()
  expect(registry.batches[0].mesh.count).toBe(20)
  registry.dispose()
})
it('keeps procedural furniture on failed loads and ignores late success after disposal', () => {
  let finish: ((value: never) => void) | undefined
  vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation(
    (_url, loaded, _progress, error) => {
      finish = loaded
      error?.(new Error('missing'))
      return undefined as never
    },
  )
  const registry = new FurnitureRegistry(vi.fn()),
    ready = vi.fn()
  registry.add('chair', { anchor: new Group(), size: [0.66, 1.2, 0.64], ready })
  expect(ready).not.toHaveBeenCalled()
  expect(registry.root.children).toHaveLength(0)
  registry.dispose()
  const geometry = new BoxGeometry(),
    dispose = vi.spyOn(geometry, 'dispose')
  const source = new Group()
  source.add(new Mesh(geometry, new MeshStandardMaterial()))
  finish?.({ scene: source } as never)
  expect(ready).not.toHaveBeenCalled()
  expect(dispose).toHaveBeenCalledOnce()
})

it('keeps the bundled sofa normals finite and nonzero after contact fitting so bloom cannot spread NaN pixels', async () => {
  const bytes = Uint8Array.from(
    readFileSync('public/office-assets/furniture/loungeSofa.glb'),
  )
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer, '')
  vi.spyOn(GLTFLoader.prototype, 'load').mockImplementation((_url, loaded) => {
    loaded(gltf)
    return undefined as never
  })
  const registry = new FurnitureRegistry(vi.fn())
  registry.add('sofa', {
    anchor: new Group(),
    size: [3, 1.18, 1.4],
    ready: vi.fn(),
  })
  await Promise.resolve()
  const normals = registry.batches[0].mesh.geometry.getAttribute('normal')
  for (let i = 0; i < normals.count; i++) {
    const length = new Vector3().fromBufferAttribute(normals, i).length()
    expect(length).toBeGreaterThan(0.5)
    expect(length).toBeLessThan(1.01)
  }
  registry.dispose()
})

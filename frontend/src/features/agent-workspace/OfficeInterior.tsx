import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  BufferAttribute,
  Color,
  Group,
  InstancedMesh,
  Mesh,
  MeshStandardMaterial,
} from 'three'
import type { BufferGeometry } from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import {
  assetUrl,
  furnitureAssets,
  furnitureAnchors,
  normalizeFurniture,
} from '@/features/agent-workspace/interiorAssets'
import type { FurnitureAsset } from '@/features/agent-workspace/interiorAssets'
import { InteriorQuality } from '@/features/agent-workspace/officePrimitives'
import {
  disposeInteriorMaterials,
  interiorMaterial,
} from '@/features/agent-workspace/interiorMaterials'
import { qualitySettings } from '@/features/agent-workspace/sceneSettings'
import type { QualityTier } from '@/features/agent-workspace/sceneSettings'

type Entry = {
  anchor: Group
  size: [number, number, number]
  tint?: string
  ready: (value: boolean) => void
}
type Batch = { mesh: InstancedMesh; entries: Entry[]; id: FurnitureAsset }
export class FurnitureRegistry {
  root = new Group()
  entries = new Map<FurnitureAsset, Set<Entry>>()
  models = new Map<FurnitureAsset, Group>()
  pending = new Set<FurnitureAsset>()
  batches: Batch[] = []
  disposed = false
  shadows = true
  tier: QualityTier = 'balanced'
  private queued = false
  private invalidate: () => void
  constructor(invalidate: () => void) {
    this.invalidate = invalidate
    this.root.name = 'office-furniture-batches'
  }
  add(id: FurnitureAsset, entry: Entry) {
    if (!this.entries.has(id)) this.entries.set(id, new Set())
    this.entries.get(id)!.add(entry)
    if (this.models.has(id)) this.schedule()
    else if (!this.pending.has(id)) {
      this.pending.add(id)
      new GLTFLoader().load(
        assetUrl(`furniture/${furnitureAssets[id]}.glb`),
        (gltf) => {
          if (this.disposed) {
            this.disposeModel(gltf.scene)
            return
          }
          this.models.set(id, gltf.scene)
          this.schedule()
        },
        undefined,
        () => {
          if (import.meta.env.DEV)
            console.debug('[office-assets] procedural fallback', id)
        },
      )
    }
    return () => {
      this.entries.get(id)?.delete(entry)
      this.schedule()
    }
  }
  private schedule() {
    if (this.queued || this.disposed) return
    this.queued = true
    queueMicrotask(() => {
      this.queued = false
      if (!this.disposed) this.rebuild()
    })
  }
  private clear() {
    this.batches.forEach(({ mesh }) => {
      mesh.removeFromParent()
      mesh.dispose()
      mesh.geometry.dispose()
      ;(mesh.material as MeshStandardMaterial).dispose()
    })
    this.batches = []
  }
  modelMaterial(id: FurnitureAsset) {
    const surface = ['desk', 'bookshelf', 'coffeeTable', 'cabinet'].includes(id)
      ? 'wood'
      : ['chair', 'sofa'].includes(id)
        ? 'fabric'
        : id === 'plant'
          ? 'plaster'
          : 'metal'
    const result = interiorMaterial('#ffffff', surface, this.tier).clone()
    result.vertexColors = true
    return result
  }
  rebuild() {
    if (this.disposed) return
    this.clear()
    for (const [id, entries] of this.entries) {
      const source = this.models.get(id)
      if (!source) continue
      const groups = new Map<string, Entry[]>()
      entries.forEach((e) => {
        const key = `${e.size}:${e.tint}`
        groups.set(key, [...(groups.get(key) || []), e])
      })
      for (const list of groups.values()) {
        const first = list[0],
          normalized = normalizeFurniture(source, first.size)
        normalized.updateMatrixWorld(true)
        const geometries: BufferGeometry[] = []
        normalized.traverse((object) => {
          if (!(object instanceof Mesh)) return
          const geometry = object.geometry.index
            ? object.geometry.toNonIndexed()
            : object.geometry.clone()
          geometry.applyMatrix4(object.matrixWorld)
          if (id === 'chair' || id === 'sofa') {
            const positions = geometry.getAttribute('position')
            const contact = furnitureAnchors[id]
            const seat =
              (contact.sourceSeat / contact.sourceHeight) * first.size[1]
            const target = contact.targetSeat
            for (let i = 0; i < positions.count; i++) {
              const y = positions.getY(i)
              positions.setY(
                i,
                y <= seat
                  ? (y * target) / seat
                  : target +
                      ((y - seat) * (first.size[1] - target)) /
                        (first.size[1] - seat),
              )
            }
            geometry.computeVertexNormals()
          }
          const sourceMaterial = object.material as MeshStandardMaterial
          const color = sourceMaterial.color.clone()
          const name = sourceMaterial.name.toLowerCase()
          if (/wood/.test(name)) color.set('#b58050')
          if (/metal/.test(name)) color.set('#45535d')
          if (first.tint && /fabric|cloth|cushion|carpet|plastic/.test(name))
            color.lerp(new Color(first.tint), 0.94)
          const colors = new Float32Array(
            geometry.getAttribute('position').count * 3,
          )
          for (let i = 0; i < colors.length; i += 3) color.toArray(colors, i)
          geometry.setAttribute('color', new BufferAttribute(colors, 3))
          const positions = geometry.getAttribute('position'),
            normals = geometry.getAttribute('normal'),
            uv = new Float32Array(positions.count * 2)
          for (let i = 0; i < positions.count; i++) {
            uv[i * 2] =
              Math.abs(normals.getX(i)) > 0.5
                ? positions.getZ(i)
                : positions.getX(i)
            uv[i * 2 + 1] =
              Math.abs(normals.getY(i)) > 0.5
                ? positions.getZ(i)
                : positions.getY(i)
          }
          for (const key of Object.keys(geometry.attributes))
            if (!['position', 'normal', 'color'].includes(key))
              geometry.deleteAttribute(key)
          geometry.setAttribute('uv', new BufferAttribute(uv, 2))
          geometries.push(geometry)
        })
        const geometry = mergeGeometries(geometries)
        geometries.forEach((g) => g.dispose())
        if (!geometry) continue
        const mesh = new InstancedMesh(
          geometry,
          this.modelMaterial(id),
          list.length,
        )
        mesh.name = `office-furniture:${id}`
        mesh.castShadow = this.shadows
        mesh.receiveShadow = true
        // Picking remains on the original React group and procedural hit surfaces.
        mesh.raycast = () => {}
        this.root.add(mesh)
        this.batches.push({ mesh, entries: list, id })
        list.forEach((e) => e.ready(true))
      }
    }
    this.update()
    this.invalidate()
  }
  update() {
    for (const batch of this.batches) {
      let changed = false
      const data = batch.mesh.instanceMatrix.array
      batch.entries.forEach((e, i) => {
        e.anchor.updateWorldMatrix(true, false)
        const elements = e.anchor.matrixWorld.elements
        if (elements.some((n, j) => Math.abs(n - data[i * 16 + j]) > 0.00001)) {
          batch.mesh.setMatrixAt(i, e.anchor.matrixWorld)
          changed = true
        }
      })
      if (changed) {
        batch.mesh.instanceMatrix.needsUpdate = true
        batch.mesh.computeBoundingSphere()
      }
    }
  }
  private disposeModel(model: Group) {
    model.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose()
        ;(Array.isArray(o.material) ? o.material : [o.material]).forEach((m) =>
          m.dispose(),
        )
      }
    })
  }
  dispose() {
    this.disposed = true
    this.clear()
    this.models.forEach((m) => this.disposeModel(m))
    this.root.removeFromParent()
  }
}
const FurnitureContext = createContext<FurnitureRegistry | null>(null)
let materialOwners = 0
export default function OfficeInterior({
  tier,
  children,
}: {
  tier: QualityTier
  children: ReactNode
}) {
  const { scene, invalidate } = useThree()
  const [registry, setRegistry] = useState<FurnitureRegistry | null>(null)
  useEffect(() => {
    const value = new FurnitureRegistry(invalidate)
    scene.add(value.root)
    materialOwners++
    setRegistry(value)
    return () => {
      value.dispose()
      materialOwners--
      queueMicrotask(() => {
        if (!materialOwners) disposeInteriorMaterials()
      })
    }
  }, [scene, invalidate])
  useFrame(() => registry?.update())
  useEffect(() => {
    if (registry) {
      registry.tier = tier
      registry.shadows = qualitySettings[tier].shadows
      registry.batches.forEach(({ mesh, id }) => {
        mesh.castShadow = registry.shadows
        ;(mesh.material as MeshStandardMaterial).dispose()
        mesh.material = registry.modelMaterial(id)
      })
    }
    invalidate()
  }, [tier, registry, invalidate])
  return (
    <InteriorQuality value={tier}>
      <FurnitureContext value={registry}>{children}</FurnitureContext>
    </InteriorQuality>
  )
}
export function FurnitureModel({
  id,
  size,
  position = [0, 0, 0],
  rotation = 0,
  tint,
  children,
}: {
  id: FurnitureAsset
  size: [number, number, number]
  position?: [number, number, number]
  rotation?: number
  tint?: string
  children?: ReactNode
}) {
  const registry = useContext(FurnitureContext),
    anchor = useRef<Group>(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setReady(false)
    if (!registry || !anchor.current) return
    return registry.add(id, {
      anchor: anchor.current,
      size,
      tint,
      ready: setReady,
    })
  }, [registry, id, size[0], size[1], size[2], tint])
  return (
    <group ref={anchor} position={position} rotation={[0, rotation, 0]}>
      <group visible={!ready} rotation={[0, -rotation, 0]}>
        {children}
      </group>
      {/* Invisible hit envelope retains the parent's existing interaction. */}
      {ready && (
        <mesh position={[0, size[1] / 2, 0]} visible={false}>
          <boxGeometry args={size} />
          <meshBasicMaterial />
        </mesh>
      )}
    </group>
  )
}
export function ContactShade({
  position = [0, 0.08, 0],
  size,
}: {
  position?: [number, number, number]
  size: [number, number]
}) {
  return (
    <mesh
      position={position}
      rotation={[-Math.PI / 2, 0, 0]}
      raycast={() => {}}
    >
      <planeGeometry args={size} />
      <meshBasicMaterial
        color="#302b26"
        transparent
        opacity={0.065}
        depthWrite={false}
      />
    </mesh>
  )
}

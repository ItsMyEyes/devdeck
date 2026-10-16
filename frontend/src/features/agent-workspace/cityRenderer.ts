// Kantor AI exterior shapes/poses, adapted to shared Three.js batches.
// Copyright (c) 2026 Kangkung Mozzarella. MIT; see THIRD_PARTY_NOTICES.md.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  EdgesGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three'
import { CityMotion, trafficVisible } from '@/features/agent-workspace/city'
import type { City, Point3 } from '@/features/agent-workspace/city'
import type { QualityTier } from '@/features/agent-workspace/sceneSettings'

type Part = {
  at: Point3
  size: Point3
  color: number
  rotation?: Point3
  parent: number
}
export function createCityScene(city: City) {
  const group = new Group()
  group.name = 'office-environment:kantor-city'
  const geometries = {
    box: new BoxGeometry(1, 1, 1),
    base: new CylinderGeometry(1, 1, 1, 64),
    trunk: new CylinderGeometry(0.16, 0.24, 1.6, 6),
    leaf: new IcosahedronGeometry(1, 2),
    cloud: new IcosahedronGeometry(1, 0),
    wheel: new CylinderGeometry(0.3, 0.3, 0.18, 16),
  }
  const surface = new MeshStandardMaterial({ roughness: 0.78, metalness: 0 })
  const foliage = new MeshStandardMaterial({ roughness: 0.85 })
  const ink = new LineBasicMaterial({
    color: 0x2a2622,
    transparent: true,
    opacity: 0.08,
  })
  const position = new Vector3(),
    scale = new Vector3(),
    rotation = new Quaternion(),
    color = new Color(),
    matrix = new Matrix4()
  const ownedEdges: BufferGeometry[] = []
  const localMatrix = (part: {
    at: Point3
    size: Point3
    rotation?: Point3
  }) => {
    position.fromArray(part.at)
    scale.fromArray(part.size)
    rotation.identity()
    if (part.rotation) {
      const [x, y, z] = part.rotation
      rotation.setFromAxisAngle(new Vector3(1, 0, 0), x)
      rotation.multiply(
        new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), y),
      )
      rotation.multiply(
        new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), z),
      )
    }
    return new Matrix4().compose(position, rotation, scale)
  }
  const batch = (
    name: string,
    geometry: BufferGeometry,
    parts: { at: Point3; size: Point3; color: number; rotation?: Point3 }[],
    leaves = false,
  ) => {
    const mesh = new InstancedMesh(
      geometry,
      leaves ? foliage : surface,
      parts.length,
    )
    mesh.name = name
    mesh.receiveShadow = true
    parts.forEach((part, i) => {
      mesh.setMatrixAt(i, localMatrix(part))
      mesh.setColorAt(i, color.setHex(part.color))
    })
    mesh.computeBoundingSphere()
    group.add(mesh)
    return mesh
  }
  for (const kind of ['box', 'base', 'trunk', 'leaf'] as const)
    batch(
      `city-${kind}`,
      geometries[kind],
      city.shapes.filter((p) => p.kind === kind),
      kind === 'leaf',
    )

  // One static ink buffer replaces hundreds of individual outline draw calls.
  const boxEdges = new EdgesGeometry(geometries.box, 25)
  const cloudEdges = new EdgesGeometry(geometries.cloud, 25)
  const wheelEdges = new EdgesGeometry(geometries.wheel, 25)
  const point = new Vector3()
  const writeEdges = (
    target: Float32Array,
    offset: number,
    source: BufferAttribute,
    transform: Matrix4,
  ) => {
    for (let i = 0; i < source.count; i++) {
      point.fromBufferAttribute(source, i).applyMatrix4(transform)
      target[offset++] = point.x
      target[offset++] = point.y
      target[offset++] = point.z
    }
    return offset
  }
  const lines = (name: string, values: Float32Array, dynamic = false) => {
    const geometry = new BufferGeometry(),
      attribute = new BufferAttribute(values, 3)
    if (dynamic) attribute.setUsage(DynamicDrawUsage)
    geometry.setAttribute('position', attribute)
    ownedEdges.push(geometry)
    const mesh = new LineSegments(geometry, ink)
    mesh.name = name
    if (dynamic) mesh.frustumCulled = false
    else geometry.computeBoundingSphere()
    group.add(mesh)
    return attribute
  }
  const outlined = city.shapes.filter((p) => p.edges)
  const staticInk = new Float32Array(
    outlined.length * boxEdges.attributes.position.count * 3,
  )
  let offset = 0
  outlined.forEach((p) => {
    offset = writeEdges(
      staticInk,
      offset,
      boxEdges.attributes.position as BufferAttribute,
      localMatrix(p),
    )
  })
  lines('city-building-edges', staticInk)

  const vehicleBoxes: Part[] = [],
    wheels: Part[] = [],
    birdBoxes: Part[] = [],
    cloudParts: Part[] = []
  city.traffic.forEach((v, parent) => {
    const box = (
      w: number,
      h: number,
      d: number,
      c: number,
      x: number,
      y: number,
      z: number,
    ) =>
      vehicleBoxes.push({
        parent,
        color: c,
        at: [x, y + h / 2, z],
        size: [w, h, d],
      })
    if (v.kind === 'bus') {
      box(2.3, 1.9, 7, v.color, 0, -0.6, 0)
      box(2.34, 0.6, 6.4, 0xa9c6c9, 0, 0.35, 0)
    } else if (v.kind === 'bike') {
      box(0.35, 0.5, 1.5, v.color, 0, -0.5, 0)
      box(0.4, 0.55, 0.4, 0x4a453e, 0, 0, -0.1)
    } else {
      box(2, 0.6, 4, v.color, 0, -0.5, 0)
      box(1.7, 0.55, 2.1, v.color, 0, 0.1, -0.2)
      box(1.72, 0.4, 0.03, 0xa9c6c9, 0, 0.18, 0.87)
    }
    for (const sz of v.kind === 'bike' ? [-0.6, 0.6] : [-1, 1])
      for (const sx of v.kind === 'bike' ? [0] : [-1, 1])
        wheels.push({
          parent,
          color: 0x4a453e,
          at: [
            sx * (v.kind === 'bus' ? 1.15 : v.kind === 'bike' ? 0 : 1),
            -0.81,
            sz * (v.kind === 'bus' ? 2.4 : v.kind === 'bike' ? 1 : 1.3),
          ],
          size: [1, 1, 1],
          rotation: [0, 0, Math.PI / 2],
        })
  })
  city.clouds.forEach((c, parent) =>
    c.puffs.forEach((p) =>
      cloudParts.push({
        parent,
        color: 0xfbf9f4,
        at: [p.x, p.y, p.z],
        size: [p.radius, p.radius * 0.55, p.radius],
      }),
    ),
  )
  city.birds.forEach((_, parent) => {
    birdBoxes.push({
      parent,
      color: 0x4a453e,
      at: [0, 0, 0],
      size: [0.22, 0.16, 0.7],
    })
    for (const side of [-1, 1])
      birdBoxes.push({
        parent,
        color: 0x4a453e,
        at: [side * 0.45, 0.02, 0],
        size: [0.9, 0.04, 0.36],
      })
  })
  const dynamicBatches = [
    {
      parts: vehicleBoxes,
      mesh: batch('city-vehicle-boxes', geometries.box, vehicleBoxes),
      source: boxEdges.attributes.position as BufferAttribute,
      kind: 'vehicle',
    },
    {
      parts: wheels,
      mesh: batch('city-vehicle-wheels', geometries.wheel, wheels),
      source: wheelEdges.attributes.position as BufferAttribute,
      kind: 'vehicle',
    },
    {
      parts: cloudParts,
      mesh: batch('city-clouds', geometries.cloud, cloudParts),
      source: cloudEdges.attributes.position as BufferAttribute,
      kind: 'cloud',
    },
    {
      parts: birdBoxes,
      mesh: batch('city-birds', geometries.box, birdBoxes),
      source: boxEdges.attributes.position as BufferAttribute,
      kind: 'bird',
    },
  ].map((b) => ({ ...b, locals: b.parts.map(localMatrix) }))
  for (const b of dynamicBatches) {
    b.mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    b.mesh.frustumCulled = false
  }
  const movingInk = new Float32Array(
    dynamicBatches.reduce((n, b) => n + b.parts.length * b.source.count * 3, 0),
  )
  const inkAttribute = lines('city-moving-edges', movingInk, true)
  const root = new Matrix4(),
    yaw = new Quaternion(),
    axisY = new Vector3(0, 1, 0),
    axisZ = new Vector3(0, 0, 1),
    flap = new Matrix4(),
    hidden = new Matrix4().makeScale(0, 0, 0)
  const update = (motion: CityMotion, tier: QualityTier) => {
    let offset = 0
    for (const b of dynamicBatches) {
      b.parts.forEach((part, i) => {
        const parent = part.parent
        let show = true
        if (b.kind === 'vehicle') {
          const v = motion.traffic[parent]
          position.set(v.x, 0, v.z)
          yaw.setFromAxisAngle(axisY, v.yaw)
          show = trafficVisible(parent, tier)
        } else if (b.kind === 'cloud') {
          const c = motion.clouds[parent]
          position.set(
            Math.cos(c.angle) * c.radius,
            c.height,
            Math.sin(c.angle) * c.radius,
          )
          yaw.identity()
        } else {
          const bird = motion.birds[parent]
          position.set(bird.x, bird.y, bird.z)
          yaw.setFromAxisAngle(axisY, bird.yaw)
        }
        root.compose(position, yaw, scale.set(1, 1, 1))
        if (b.kind === 'bird' && i % 3 !== 0) {
          const angle = motion.birds[parent].flap * (i % 3 === 1 ? -1 : 1)
          flap.makeRotationFromQuaternion(
            rotation.setFromAxisAngle(axisZ, angle),
          )
          root.multiply(flap)
        }
        matrix.multiplyMatrices(root, show ? b.locals[i] : hidden)
        b.mesh.setMatrixAt(i, matrix)
        offset = writeEdges(movingInk, offset, b.source, matrix)
      })
      b.mesh.instanceMatrix.needsUpdate = true
    }
    inkAttribute.needsUpdate = true
    group.userData.visibleVehicles = tier === 'low' ? 8 : 20
  }
  update(new CityMotion(city), 'balanced')
  return {
    group,
    update,
    dispose() {
      Object.values(geometries).forEach((g) => g.dispose())
      for (const g of [boxEdges, cloudEdges, wheelEdges, ...ownedEdges])
        g.dispose()
      surface.dispose()
      foliage.dispose()
      ink.dispose()
      group.traverse((o) => {
        if (o instanceof InstancedMesh) o.dispose()
      })
    },
  }
}

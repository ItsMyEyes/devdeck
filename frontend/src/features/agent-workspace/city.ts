// Exterior ported from Kantor AI, 1bc084b682519c8a436ac255b205d77e6618e696.
// Copyright (c) 2026 Kangkung Mozzarella. MIT; see THIRD_PARTY_NOTICES.md.
import type { QualityTier } from '@/features/agent-workspace/sceneSettings'

export type Point3 = [number, number, number]
export type CityShape = {
  kind: 'box' | 'base' | 'trunk' | 'leaf'
  at: Point3
  size: Point3
  color: number
  edges?: boolean
}
export type Vehicle = {
  kind: 'car' | 'bus' | 'bike'
  color: number
  axis: 'x' | 'z'
  fixed: number
  direction: number
  pos: number
  speed: number
}
export type City = ReturnType<typeof createCity>
export type CityBounds = {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
}

function random(seed: number) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647
}

export function fitCity(bounds: CityBounds) {
  // Fit the entire floor/lounges inside the reference's original office envelope.
  const width = bounds.maxX - bounds.minX + 8,
    depth = bounds.maxZ - bounds.minZ + 8
  const straight = Math.max(1, width / 39.85, depth / 25.1)
  const turned = Math.max(1, width / 25.1, depth / 39.85)
  const rotate = turned < straight,
    scale = rotate ? turned : straight
  return {
    scale,
    rotation: rotate ? Math.PI / 2 : 0,
    x: (bounds.minX + bounds.maxX) / 2 + (rotate ? 0 : 3.375 * scale),
    y: -0.48 + 0.9 * scale,
    z: (bounds.minZ + bounds.maxZ) / 2 - (rotate ? 3.375 * scale : 0),
    far: Math.max(500, 400 * scale),
  }
}

export function createCity() {
  const shapes: CityShape[] = []
  const buildings: {
    x: number
    z: number
    width: number
    depth: number
    height: number
  }[] = []
  const trees: [number, number, number][] = []
  const box = (
    w: number,
    h: number,
    d: number,
    color: number,
    x: number,
    y: number,
    z: number,
    edges = true,
  ) => {
    shapes.push({
      kind: 'box',
      color,
      at: [x, y + h / 2, z],
      size: [w, h, d],
      edges,
    })
  }
  const flat = (
    w: number,
    d: number,
    color: number,
    x: number,
    y: number,
    z: number,
  ) => box(w, 0.02, d, color, x, y, z, false)
  const PAVEMENT = 0xe4dfd3,
    LAWN = 0xa9cc7a,
    SIDEWALK = 0xf1eee7,
    ASPHALT = 0xa9a8a3,
    LINE = 0xfbfaf6
  shapes.push({
    kind: 'base',
    color: PAVEMENT,
    at: [0, -1.1, 0],
    size: [150, 0.4, 150],
  })
  flat(66, 46, LAWN, -6, -0.9, -4.5)
  for (const z of [19.8, 28.2]) flat(290, 2.4, SIDEWALK, 0, -0.89, z)
  for (const x of [29.8, 38.2]) flat(2.4, 290, SIDEWALK, x, -0.89, 0)
  flat(290, 6, ASPHALT, 0, -0.88, 24)
  flat(6, 290, ASPHALT, 34, -0.875, 0)
  flat(14, 8.5, 0xd6d1c6, 8.25, -0.885, 16.75)
  for (const x of [3, 13.5]) flat(0.2, 8.5, LINE, x, -0.86, 16.75)
  for (let i = -140; i <= 140; i += 8) {
    if (Math.abs(i - 34) > 5) flat(3, 0.25, LINE, i, -0.86, 24)
    if (Math.abs(i - 24) > 5) flat(0.25, 3, LINE, 34, -0.86, i)
  }
  for (let k = 0; k < 6; k++) {
    flat(0.5, 5, LINE, 27.4 - k * 0.9, -0.855, 24)
    flat(5, 0.5, LINE, 34, -0.855, 17.4 - k * 0.9)
  }
  const rnd = random(29),
    tones = [0xf3eee4, 0xe9e2d4, 0xf7f3ec, 0xe1d9ca]
  for (let placed = 0, tries = 0; placed < 64 && tries < 600; tries++) {
    const a = rnd() * Math.PI * 2,
      dist = 40 + rnd() * 100,
      x = Math.cos(a) * dist,
      z = Math.sin(a) * dist,
      w = 6 + rnd() * 7,
      d = 6 + rnd() * 7
    if (Math.hypot(x, z) + Math.max(w, d) > 145) continue
    if (Math.abs(z - 24) < d / 2 + 6 || Math.abs(x - 34) < w / 2 + 6) continue
    if (x > -40 && x < 28 && z > -28 && z < 22) continue
    const h = dist < 65 ? 4 + rnd() * 10 : 8 + rnd() * (dist / 140) * 42
    flat(w + 3, d + 3, rnd() < 0.5 ? LAWN : SIDEWALK, x, -0.895, z)
    box(w, h, d, tones[placed % 4], x, -0.9, z)
    for (let y = 2; y < h - 1; y += 2.6)
      box(w + 0.04, 0.55, d + 0.04, 0xbfd3d9, x, -0.9 + y, z, false)
    if (rnd() < 0.35) flat(w * 0.8, d * 0.8, 0x9fbf73, x, h - 0.88, z)
    else if (rnd() < 0.5) box(w * 0.35, 1.2, d * 0.35, 0xcfc8ba, x, h - 0.9, z)
    buildings.push({ x, z, width: w, depth: d, height: h })
    placed++
  }
  const clearOfRoads = (x: number, z: number) =>
    Math.abs(z - 24) > 4.2 && Math.abs(x - 34) > 4.2
  for (let x = -140; x <= 140; x += 7)
    for (const z of [18.4, 29.6])
      if (clearOfRoads(x, z) && (x < 0 || x > 16.5) && Math.hypot(x, z) < 142)
        trees.push([x, z, 0.9 + rnd() * 0.3])
  for (let z = -140; z <= 140; z += 7)
    for (const x of [28.4, 39.6])
      if (clearOfRoads(x, z) && Math.hypot(x, z) < 142)
        trees.push([x, z, 0.9 + rnd() * 0.3])
  trees.push(
    [-30, -20, 1.4],
    [-34, -8, 1.2],
    [-32, 6, 1.3],
    [-30, 15, 1.1],
    [-24, -22, 1.2],
    [-12, -22, 1.3],
    [0, -23, 1.1],
    [12, -22, 1.4],
    [22, -18, 1.2],
    [23, -6, 1.1],
    [22, 6, 1.3],
    [21, 15, 1],
    [-8, 17, 0.8],
    [-14, 17, 0.7],
    [-2, 17.5, 0.7],
    [-26, 17, 0.9],
  )
  for (let placed = 0, tries = 0; placed < 130 && tries < 900; tries++) {
    const a = rnd() * Math.PI * 2,
      dist = 30 + rnd() * 112,
      x = Math.cos(a) * dist,
      z = Math.sin(a) * dist
    if (x > -40 && x < 28 && z > -28 && z < 22) continue
    if (!clearOfRoads(x, z) || Math.abs(z - 24) < 6.5 || Math.abs(x - 34) < 6.5)
      continue
    trees.push([x, z, 0.8 + rnd() * 0.7])
    placed++
  }
  const puffs = [
      [0, 2.3, 0, 1.25],
      [0.6, 1.85, 0.4, 0.95],
      [-0.55, 1.95, -0.35, 1],
    ],
    greens = [0x6fa84a, 0x8cc05a, 0x5f9640]
  trees.forEach(([x, z, s], i) => {
    shapes.push({
      kind: 'trunk',
      color: 0x7a5e45,
      at: [x, -0.9 + 0.8 * s, z],
      size: [s, s, s],
    })
    puffs.forEach(([dx, dy, dz, r], k) =>
      shapes.push({
        kind: 'leaf',
        color: greens[(i + k) % 3],
        at: [x + dx * s, -0.9 + dy * s, z + dz * s],
        size: [r * s, r * s * 0.92, r * s],
      }),
    )
  })
  const cloudRnd = random(71)
  const clouds = Array.from({ length: 12 }, (_, i) => {
    const angle = (i / 12) * Math.PI * 2 + cloudRnd() * 0.3,
      radius = 150 + cloudRnd() * 25,
      height = 15 + cloudRnd() * 10
    const puffs = Array.from({ length: 4 }, (_, k) => ({
      radius: 4 + cloudRnd() * 4,
      x: k * 5 - 7,
      y: cloudRnd() * 2,
      z: cloudRnd() * 4 - 2,
    }))
    return { angle, radius, height, puffs, speed: 1 + cloudRnd() * 1.5 }
  })
  const birds = Array.from({ length: 8 }, (_, i) => ({
    radius: 28 + i * 4,
    height: 30 + (i % 4) * 7,
    speed: (0.18 + (i % 3) * 0.05) * (i % 2 ? 1 : -1),
    angle: i * 0.8,
  }))
  const traffic: Vehicle[] = [],
    trafficRnd = random(53),
    paints = [
      0xd6d0c4, 0x6f8580, 0xb4623a, 0x2f4a6b, 0xd8a13a, 0x8a8479, 0x3f7a58,
    ]
  const lanes = [
    ['x', 22.5, 1],
    ['x', 25.5, -1],
    ['z', 32.5, -1],
    ['z', 35.5, 1],
  ] as const
  lanes.forEach(([axis, fixed, direction], li) => {
    for (let i = 0; i < 5; i++) {
      const kind =
        trafficRnd() < 0.15 ? 'bus' : trafficRnd() < 0.3 ? 'bike' : 'car'
      traffic.push({
        kind,
        color: paints[(li * 5 + i) % paints.length],
        axis,
        fixed,
        direction,
        pos: -130 + i * 54 + trafficRnd() * 14,
        speed: 8 + li * 0.8,
      })
    }
  })
  return { shapes, buildings, trees, clouds, birds, traffic }
}

export function trafficVisible(index: number, tier: QualityTier) {
  return tier !== 'low' || index % 5 === 0 || index % 5 === 2
}

export class CityMotion {
  time = 0
  traffic: (Vehicle & { x: number; z: number; yaw: number })[]
  clouds: City['clouds']
  birds: (City['birds'][number] & {
    flap: number
    x: number
    y: number
    z: number
    yaw: number
  })[]
  constructor(city: City) {
    this.traffic = city.traffic.map((v) => ({
      ...v,
      x: v.axis === 'x' ? v.pos * v.direction : v.fixed,
      z: v.axis === 'z' ? v.pos * v.direction : v.fixed,
      yaw:
        v.axis === 'x'
          ? v.direction > 0
            ? Math.PI / 2
            : -Math.PI / 2
          : v.direction > 0
            ? 0
            : Math.PI,
    }))
    this.clouds = city.clouds.map((c) => ({ ...c }))
    this.birds = city.birds.map((b) => ({
      ...b,
      flap: 0,
      x: 0,
      y: 0,
      z: 0,
      yaw: 0,
    }))
    this.placeBirds()
  }
  private placeBirds() {
    for (const b of this.birds) {
      b.x = Math.cos(b.angle) * b.radius - 3
      b.y = b.height + Math.sin(b.angle * 3) * 1.5
      b.z = Math.sin(b.angle) * b.radius
      b.yaw = -b.angle + (b.speed > 0 ? Math.PI : 0)
      b.flap = Math.sin(this.time * 9 + b.radius) * 0.6
    }
  }
  tick(delta: number, visible: boolean, reduced: boolean, tier: QualityTier) {
    if (
      !visible ||
      reduced ||
      !Number.isFinite(delta) ||
      delta <= 0 ||
      delta > 0.25
    )
      return false
    const dt = Math.min(delta, 0.05)
    for (const v of this.traffic) {
      v.pos += v.speed * dt
      if (v.pos > 135) v.pos = -135
      if (v.axis === 'x') v.x = v.pos * v.direction
      else v.z = v.pos * v.direction
    }
    if (tier !== 'low') {
      this.time += dt
      for (const c of this.clouds) c.angle += (c.speed * dt) / c.radius
      for (const b of this.birds) b.angle += b.speed * dt
      this.placeBirds()
    }
    return true
  }
}

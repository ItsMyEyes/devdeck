import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { useFrame, useThree } from '@react-three/fiber'
import { Raycaster, Vector3 } from 'three'
import type { Object3D } from 'three'
import type { OfficeView } from '@/features/agent-workspace/model'
import { placeLabels } from '@/features/agent-workspace/labelLayout'
import type { Group } from 'three'

export function createOfficeLabel(host: HTMLElement) {
  const element = document.createElement('div')
  element.style.cssText =
    'position:absolute;top:0;left:0;pointer-events:none;transform-origin:0 0;'
  host.append(element)
  const root = createRoot(element)
  let disposed = false
  return {
    element,
    render(children: ReactNode) {
      if (!disposed) root.render(children)
    },
    dispose() {
      if (disposed) return
      disposed = true
      element.remove()
      // Fiber can detach a label during React's commit; unmount its DOM root afterwards.
      queueMicrotask(() => root.unmount())
    },
  }
}

type Entry = {
  id: string
  group: Group
  element: HTMLElement
  priority: number
  kind: string
  center: boolean
  leader?: HTMLElement
}
const registries = new WeakMap<HTMLElement, Set<Entry>>()
export function officeLabelsFor(host: HTMLElement) {
  if (!registries.has(host)) registries.set(host, new Set())
  return registries.get(host)!
}
let nextId = 0
export function OfficeLabelManager({ view }: { view: OfficeView }) {
  const { gl, camera, size, scene, frameloop } = useThree()
  const time = useRef(1),
    structures = useRef<Object3D[]>([]),
    refresh = useRef(1)
  const math = useRef({
    point: new Vector3(),
    direction: new Vector3(),
    origin: new Vector3(),
    ray: new Raycaster(),
  })
  useFrame((_, delta) => {
    time.current += Math.min(delta, 0.1)
    refresh.current += Math.min(delta, 0.1)
    if (frameloop === 'always' && time.current < 0.08) return
    time.current = 0
    const host = gl.domElement.parentElement
    const entries = host && registries.get(host)
    if (!entries) return
    if (refresh.current >= 1) {
      structures.current = []
      scene.traverse((o) => {
        if (o.userData.officeStructure) structures.current.push(o)
      })
      refresh.current = 0
    }
    const v = math.current,
      boxes = [],
      positions = new Map<string, { x: number; y: number }>()
    camera.getWorldPosition(v.origin)
    for (const entry of entries) {
      const { element, group, priority, kind } = entry
      group.getWorldPosition(v.point)
      const distance = v.origin.distanceTo(v.point)
      let hidden = view === 'building' && kind === 'zone' && priority < 2
      if (!hidden && priority === 0 && structures.current.length) {
        v.direction.subVectors(v.point, v.origin).normalize()
        v.ray.set(v.origin, v.direction)
        v.ray.far = distance - 0.12
        hidden = v.ray.intersectObjects(structures.current, false).length > 0
      }
      v.point.project(camera)
      hidden ||=
        v.point.z < -1 ||
        v.point.z > 1 ||
        Math.abs(v.point.x) > 1.1 ||
        Math.abs(v.point.y) > 1.1
      element.style.visibility = hidden ? 'hidden' : ''
      entry.leader?.style.setProperty('display', 'none')
      if (hidden) continue
      const x = ((v.point.x + 1) * size.width) / 2,
        y = ((1 - v.point.y) * size.height) / 2
      positions.set(entry.id, { x, y })
      boxes.push({
        id: entry.id,
        x,
        y,
        width: element.offsetWidth,
        height: element.offsetHeight,
        priority,
      })
    }
    const ordinary = boxes.filter((b) => b.priority >= 0)
    const placed = [
      ...placeLabels(ordinary, size.width, size.height),
      ...boxes
        .filter((b) => b.priority < 0)
        .map((b) => ({ ...b, visible: true })),
    ]
    for (const value of placed) {
      const entry = [...entries].find((e) => e.id === value.id)!,
        original = positions.get(value.id)!
      entry.element.style.visibility = value.visible ? '' : 'hidden'
      entry.element.style.transform = `translate3d(${value.x}px,${value.y}px,0)`
      entry.element.style.zIndex = String(
        value.priority >= 2 ? 20 : value.priority === 1 ? 10 : 2,
      )
      if (
        value.visible &&
        value.priority >= 2 &&
        Math.hypot(value.x - original.x, value.y - original.y) > 8
      ) {
        if (!entry.leader) {
          entry.leader = document.createElement('div')
          entry.leader.className = 'office-label-leader'
          host!.append(entry.leader)
        }
        const dx = value.x - original.x,
          dy = value.y - original.y
        entry.leader.style.cssText = `position:absolute;pointer-events:none;left:${original.x}px;top:${original.y}px;width:${Math.hypot(dx, dy)}px;height:1px;background:var(--color-devdeck-fg-2);transform-origin:0 0;transform:rotate(${Math.atan2(dy, dx)}rad);opacity:.5;`
      }
    }
  })
  return null
}
export default function OfficeHtml({
  children,
  position,
  center = false,
  zIndexRange = [1, 0],
  priority = 0,
  kind = 'zone',
}: {
  children: ReactNode
  position: [number, number, number]
  center?: boolean
  zIndexRange?: [number, number]
  priority?: number
  kind?: 'zone' | 'floor' | 'actor'
}) {
  const group = useRef<Group>(null),
    label = useRef<ReturnType<typeof createOfficeLabel> | null>(null),
    entry = useRef<Entry | null>(null)
  const { gl, invalidate } = useThree()
  useEffect(() => {
    const host = gl.domElement.parentElement
    if (!host || !group.current) return
    const value = createOfficeLabel(host)
    label.current = value
    if (!registries.has(host)) registries.set(host, new Set())
    const item: Entry = {
      id: String(nextId++).padStart(5, '0'),
      group: group.current,
      element: value.element,
      priority,
      kind,
      center,
    }
    entry.current = item
    officeLabelsFor(host).add(item)
    invalidate()
    return () => {
      registries.get(host)?.delete(item)
      item.leader?.remove()
      label.current = null
      entry.current = null
      value.dispose()
    }
  }, [gl, invalidate])
  useEffect(() => {
    if (entry.current) {
      entry.current.priority = priority
      entry.current.kind = kind
    }
    label.current?.render(
      <div
        style={{
          transform: center ? 'translate(-50%,-50%)' : undefined,
          pointerEvents: 'auto',
        }}
      >
        {children}
      </div>,
    )
    invalidate()
  }, [children, center, priority, kind, invalidate])
  void zIndexRange
  return <group ref={group} position={position} />
}

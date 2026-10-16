import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { useFrame, useThree } from '@react-three/fiber'
import { Vector3 } from 'three'
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

// Workspace labels only need projected positions, not independent synchronous roots.
export default function OfficeHtml({
  children,
  position,
  center = false,
  zIndexRange = [1, 0],
}: {
  children: ReactNode
  position: [number, number, number]
  center?: boolean
  zIndexRange?: [number, number]
}) {
  const group = useRef<Group>(null)
  const label = useRef<ReturnType<typeof createOfficeLabel> | null>(null)
  const vector = useRef(new Vector3())
  const { gl, camera, size, invalidate } = useThree()
  useEffect(() => {
    const host = gl.domElement.parentElement
    if (!host) return
    const value = createOfficeLabel(host)
    label.current = value
    invalidate()
    return () => {
      label.current = null
      value.dispose()
    }
  }, [gl, invalidate])
  useEffect(() => {
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
  }, [children, center])
  useFrame(() => {
    const node = group.current,
      el = label.current?.element
    if (!node || !el) return
    node.getWorldPosition(vector.current).project(camera)
    const p = vector.current
    el.style.display =
      p.z < -1 || p.z > 1 || Math.abs(p.x) > 1.2 || Math.abs(p.y) > 1.2
        ? 'none'
        : ''
    el.style.transform = `translate3d(${((p.x + 1) * size.width) / 2}px,${((1 - p.y) * size.height) / 2}px,0)`
    el.style.zIndex = String(zIndexRange[0])
  })
  return <group ref={group} position={position} />
}

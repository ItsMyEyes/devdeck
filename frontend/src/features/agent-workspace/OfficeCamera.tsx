import { useCallback, useEffect, useRef } from 'react'
import type { ComponentRef } from 'react'
import { useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Vector3, MOUSE, TOUCH } from 'three'
import { applyCameraAction } from '@/features/agent-workspace/camera'
import type { OfficeView } from '@/features/agent-workspace/model'

export default function OfficeCamera({
  workspaceId,
  view,
  center,
  span,
  reset,
  selected,
  action,
  mode,
  focusId,
}: {
  workspaceId: string
  view: OfficeView
  center: [number, number, number]
  span: number
  reset: number
  selected?: [number, number, number]
  action: { id: number; type: string }
  mode: 'pan' | 'rotate'
  focusId: number
}) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null)
  const { camera, invalidate } = useThree()
  const saveCamera = useCallback(() => {
    const c = controls.current
    if (!c) return
    try {
      localStorage.setItem(
        `devdeck.office-camera.${workspaceId}.${view}`,
        JSON.stringify({
          position: camera.position.toArray(),
          target: c.target.toArray(),
        }),
      )
    } catch {
      /* Optional preference. */
    }
  }, [camera, workspaceId, view])
  const defaults = useRef({ center, span })
  defaults.current = { center, span }
  const lastReset = useRef(reset)
  useEffect(() => {
    const resetting = lastReset.current !== reset
    lastReset.current = reset
    const c = controls.current
    if (!c) return
    const { center, span } = defaults.current
    const target = new Vector3(...center)
    camera.position.set(
      target.x + span * 0.8,
      target.y + span * 0.9,
      target.z + span * 0.8,
    )
    c.target.copy(target)
    try {
      const saved = JSON.parse(
        localStorage.getItem(`devdeck.office-camera.${workspaceId}.${view}`) ||
          'null',
      )
      if (
        !resetting &&
        saved &&
        [saved.position, saved.target].every(
          (a) =>
            Array.isArray(a) &&
            a.length === 3 &&
            a.every(
              (n: unknown) =>
                typeof n === 'number' &&
                Number.isFinite(n) &&
                Math.abs(n) < 10000,
            ),
        )
      ) {
        camera.position.fromArray(saved.position)
        c.target.fromArray(saved.target)
      }
    } catch {
      /* Camera preferences are optional. */
    }
    c.update()
    if (resetting) saveCamera()
    invalidate()
  }, [workspaceId, view, reset, camera, invalidate, saveCamera])
  const lastFocus = useRef(focusId)
  useEffect(() => {
    const c = controls.current
    if (!c || !selected || lastFocus.current === focusId) return
    lastFocus.current = focusId
    const next = new Vector3(...selected)
    camera.position.add(next.clone().sub(c.target))
    c.target.copy(next)
    c.update()
    saveCamera()
    invalidate()
  }, [
    focusId,
    selected?.[0],
    selected?.[1],
    selected?.[2],
    camera,
    invalidate,
    saveCamera,
  ])
  const lastAction = useRef(action.id)
  useEffect(() => {
    const c = controls.current
    if (!c || !action.id || lastAction.current === action.id) return
    lastAction.current = action.id
    applyCameraAction(camera, c.target, action.type)
    c.update()
    saveCamera()
    invalidate()
  }, [action, camera, invalidate, saveCamera])
  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping={false}
      minDistance={5}
      maxDistance={100}
      minPolarAngle={0.2}
      maxPolarAngle={Math.PI / 2.25}
      enablePan
      screenSpacePanning={false}
      mouseButtons={{
        LEFT: mode === 'pan' ? MOUSE.PAN : MOUSE.ROTATE,
        MIDDLE: MOUSE.DOLLY,
        RIGHT: mode === 'pan' ? MOUSE.ROTATE : MOUSE.PAN,
      }}
      touches={{
        ONE: mode === 'pan' ? TOUCH.PAN : TOUCH.ROTATE,
        TWO: TOUCH.DOLLY_PAN,
      }}
      onEnd={saveCamera}
    />
  )
}

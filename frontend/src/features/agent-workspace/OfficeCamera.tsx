import { useCallback, useEffect, useRef } from 'react'
import type { ComponentRef } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { Vector3, MOUSE, TOUCH } from 'three'
import { applyCameraAction } from '@/features/agent-workspace/camera'
import type { OfficeView } from '@/features/agent-workspace/model'

const noop = () => {}
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
  follow = false,
  onFollowChange = noop,
  getSelected,
  visible = true,
  reduced = false,
  lounge,
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
  follow?: boolean
  onFollowChange?: (follow: boolean) => void
  getSelected?: () => [number, number, number] | undefined
  visible?: boolean
  reduced?: boolean
  lounge?: [number, number, number]
}) {
  const controls = useRef<ComponentRef<typeof OrbitControls>>(null)
  const { camera, invalidate } = useThree()
  const live = useRef({
    getSelected,
    selected,
    follow,
    visible,
    onFollowChange,
    reduced,
  })
  live.current = {
    getSelected,
    selected,
    follow,
    visible,
    onFollowChange,
    reduced,
  }
  const vectors = useRef({ next: new Vector3(), delta: new Vector3() })
  useFrame((_, dt) => {
    const current = live.current,
      c = controls.current
    if (!current.follow || !current.visible || !c) return
    const point = current.getSelected ? current.getSelected() : current.selected
    if (!point) {
      current.onFollowChange(false)
      return
    }
    const v = vectors.current
    v.next.fromArray(point)
    v.delta
      .subVectors(v.next, c.target)
      .multiplyScalar(current.reduced ? 1 : 1 - Math.exp(-(dt || 1 / 60) * 8))
    camera.position.add(v.delta)
    c.target.add(v.delta)
    c.update()
  })
  const previousView = useRef(view)
  useEffect(() => {
    if (previousView.current !== view) {
      previousView.current = view
      onFollowChange(false)
    }
  }, [view, onFollowChange])
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
    if (resetting) onFollowChange(false)
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
    onFollowChange(false)
    if (['overview', 'desk', 'lounge'].includes(action.type)) {
      const { center, span } = defaults.current
      const point =
        action.type === 'desk'
          ? getSelected
            ? getSelected()
            : selected
          : action.type === 'lounge'
            ? lounge
            : center
      if (point) {
        c.target.fromArray(point)
        const distance =
          action.type === 'overview' ? span : action.type === 'desk' ? 5 : 12
        camera.position.set(
          point[0] + distance * 0.8,
          point[1] + distance * 0.9,
          point[2] + distance * 0.8,
        )
      }
    } else applyCameraAction(camera, c.target, action.type)
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
      onStart={() => onFollowChange(false)}
      onEnd={saveCamera}
    />
  )
}

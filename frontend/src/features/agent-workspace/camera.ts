import { Vector3 } from 'three'
import type { Camera } from 'three'

export function applyCameraAction(
  camera: Camera,
  target: Vector3,
  type: string,
) {
  const offset = camera.position.clone().sub(target)
  if (['left', 'right', 'up', 'down'].includes(type)) {
    const direction =
      type === 'left' || type === 'right'
        ? new Vector3(offset.z, 0, -offset.x)
        : new Vector3(-offset.x, 0, -offset.z)
    direction
      .normalize()
      .multiplyScalar(
        offset.length() * 0.08 * (type === 'left' || type === 'down' ? -1 : 1),
      )
    camera.position.add(direction)
    target.add(direction)
    return
  }
  if (type === 'rotate')
    offset.applyAxisAngle(new Vector3(0, 1, 0), Math.PI / 4)
  else offset.multiplyScalar(type === 'in' ? 0.8 : 1.25)
  offset.clampLength(5, 100)
  camera.position.copy(target).add(offset)
}

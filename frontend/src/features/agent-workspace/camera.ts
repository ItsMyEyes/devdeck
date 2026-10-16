import { Vector3 } from 'three'
import type { Camera } from 'three'

export function officeCameraOffset(
  bounds: [number, number, number],
  fov: number,
  aspect: number,
) {
  const direction = new Vector3(0.8, 0.9, 0.8).normalize()
  const right = new Vector3(direction.z, 0, -direction.x).normalize()
  const up = new Vector3().crossVectors(direction, right)
  const tangent = Math.tan((fov * Math.PI) / 360) * 0.9
  let distance = 5
  for (const x of [-bounds[0] / 2, bounds[0] / 2])
    for (const y of [-bounds[1] / 2, bounds[1] / 2])
      for (const z of [-bounds[2] / 2, bounds[2] / 2]) {
        const point = new Vector3(x, y, z)
        distance = Math.max(
          distance,
          point.dot(direction) +
            Math.max(
              Math.abs(point.dot(right)) / (tangent * aspect),
              Math.abs(point.dot(up)) / tangent,
            ),
        )
      }
  return direction.multiplyScalar(distance)
}

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

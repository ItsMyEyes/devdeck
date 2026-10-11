import {
  BoxGeometry,
  CylinderGeometry,
  MeshStandardMaterial,
  SphereGeometry,
} from 'three'
export const box = new BoxGeometry(1, 1, 1)
export const sphere = new SphereGeometry(1, 10, 8)
export const cylinder = new CylinderGeometry(1, 1, 1, 10)
const materials = new Map<string, MeshStandardMaterial>()
export function material(color: string) {
  let value = materials.get(color)
  if (!value) {
    value = new MeshStandardMaterial({ color, roughness: 0.85 })
    materials.set(color, value)
  }
  return value
}
export function Block({
  at,
  size,
  color,
  rotation = 0,
  round = false,
}: {
  at: [number, number, number]
  size: [number, number, number]
  color: string
  rotation?: number
  round?: boolean
}) {
  return (
    <mesh
      position={at}
      scale={size}
      rotation={[0, rotation, 0]}
      geometry={round ? sphere : box}
      material={material(color)}
      receiveShadow
    />
  )
}

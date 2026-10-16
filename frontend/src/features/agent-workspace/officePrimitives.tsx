import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import {
  BoxGeometry,
  CylinderGeometry,
  MeshStandardMaterial,
  SphereGeometry,
} from 'three'
export const box = new BoxGeometry(1, 1, 1)
export const sphere = new SphereGeometry(1, 10, 8)
export const cylinder = new CylinderGeometry(1, 1, 1, 10)
const bevel = new RoundedBoxGeometry(1, 1, 1, 2, 0.055)
export type Surface =
  'generic' | 'wood' | 'fabric' | 'metal' | 'glass' | 'screen'
const profiles = {
  generic: { roughness: 0.85 },
  wood: { roughness: 0.65 },
  fabric: { roughness: 0.98 },
  metal: { roughness: 0.3, metalness: 0.65 },
  glass: {
    roughness: 0.12,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  },
  screen: { roughness: 0.3, emissiveIntensity: 0.35 },
}
const materials = new Map<string, MeshStandardMaterial>()
export function material(color: string, surface: Surface = 'generic') {
  const key = `${surface}:${color}`
  let value = materials.get(key)
  if (!value) {
    value = new MeshStandardMaterial({
      color,
      ...profiles[surface],
      ...(surface === 'screen' ? { emissive: color } : {}),
    })
    materials.set(key, value)
  }
  return value
}
export function Block({
  at,
  size,
  color,
  rotation = 0,
  round = false,
  surface = 'generic',
  soft = false,
  shadow = false,
}: {
  at: [number, number, number]
  size: [number, number, number]
  color: string
  rotation?: number
  round?: boolean
  surface?: Surface
  soft?: boolean
  shadow?: boolean
}) {
  return (
    <mesh
      position={at}
      scale={size}
      rotation={[0, rotation, 0]}
      geometry={round ? sphere : soft ? bevel : box}
      material={material(color, surface)}
      castShadow={shadow}
      receiveShadow
    />
  )
}

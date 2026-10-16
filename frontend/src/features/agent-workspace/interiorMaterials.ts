import {
  DataTexture,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  LinearFilter,
  LinearMipmapLinearFilter,
} from 'three'
import type { QualityTier } from '@/features/agent-workspace/sceneSettings'
import { qualitySettings } from '@/features/agent-workspace/sceneSettings'

export type InteriorSurface = 'wood' | 'plaster' | 'fabric' | 'metal'
export const interiorPalette = {
  oak: '#b58050',
  wall: '#efe4d3',
  frame: '#35424b',
  teal: '#397e78',
  blue: '#426a91',
  terracotta: '#bb7053',
  fabric: '#466d79',
}
const noise = (x: number, y: number) => {
  let h = Math.imul(x + 17, 374761393) ^ Math.imul(y + 71, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return (h >>> 0) / 4294967295
}
export function texturePixels(surface: InteriorSurface, size: number) {
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size,
        v = y / size,
        n = noise(x, y)
      let shade = 0.9 + n * 0.1
      if (surface === 'wood') {
        const plank = Math.floor(v * 8),
          offset = (plank % 2) * 0.5
        const seam = (v * 8) % 1 < 0.012 || (u * 2 + offset) % 1 < 0.006
        shade = seam
          ? 0.48
          : 0.79 +
            noise(plank, Math.floor(u * 2 + offset)) * 0.18 +
            Math.sin(u * 220 + Math.sin(v * 25) * 2) * 0.025 +
            n * 0.035
      } else if (surface === 'fabric')
        shade = 0.82 + (x % 3 === 0 || y % 3 === 0 ? 0.05 : 0.12) + n * 0.05
      else if (surface === 'metal') shade = 0.85 + noise(1, y) * 0.12 + n * 0.03
      const i = (y * size + x) * 4
      pixels[i] =
        pixels[i + 1] =
        pixels[i + 2] =
          Math.round(Math.min(1, Math.max(0, shade)) * 255)
      pixels[i + 3] = 255
    }
  return pixels
}
const textures = new Map<
  string,
  { map: DataTexture; normal: DataTexture; rough: DataTexture }
>()
const materials = new Map<string, MeshStandardMaterial>()
export function interiorMaterial(
  color: string,
  surface: InteriorSurface,
  tier: QualityTier,
  repeat: [number, number] = [1, 1],
) {
  const key = `${color}:${surface}:${tier}:${repeat.join(',')}`
  const prior = materials.get(key)
  if (prior) return prior
  const size = qualitySettings[tier].textureSize
  const texKey = `${surface}:${size}:${repeat.join(',')}`
  let tex = textures.get(texKey)
  if (!tex) {
    const pixels = texturePixels(surface, size),
      normals = new Uint8Array(pixels.length),
      roughness = new Uint8Array(pixels.length)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4
        normals[i] =
          128 + (pixels[(y * size + ((x + 1) % size)) * 4] - pixels[i]) * 0.35
        normals[i + 1] =
          128 + (pixels[(((y + 1) % size) * size + x) * 4] - pixels[i]) * 0.35
        normals[i + 2] = normals[i + 3] = 255
        roughness[i] =
          roughness[i + 1] =
          roughness[i + 2] =
            surface === 'metal'
              ? 100 + pixels[i] / 4
              : surface === 'fabric' || surface === 'plaster'
                ? 235
                : 165 + pixels[i] / 5
        roughness[i + 3] = 255
      }
    const make = (data: Uint8Array) => {
      const texture = new DataTexture(data, size, size)
      texture.wrapS = texture.wrapT = RepeatWrapping
      texture.repeat.set(...repeat)
      texture.needsUpdate = true
      texture.generateMipmaps = true
      texture.minFilter = LinearMipmapLinearFilter
      texture.magFilter = LinearFilter
      texture.anisotropy = 4
      return texture
    }
    tex = { map: make(pixels), normal: make(normals), rough: make(roughness) }
    tex.map.colorSpace = SRGBColorSpace
    textures.set(texKey, tex)
  }
  const value = new MeshStandardMaterial({
    color,
    map: tex.map,
    roughnessMap: tex.rough,
    normalMap: qualitySettings[tier].normalMaps ? tex.normal : null,
    roughness: 1,
    metalness: surface === 'metal' ? 0.65 : 0,
    envMapIntensity: 0.35,
  })
  value.normalScale.setScalar(surface === 'wood' ? 0.25 : 0.1)
  materials.set(key, value)
  return value
}
export function disposeInteriorMaterials() {
  materials.forEach((m) => m.dispose())
  materials.clear()
  textures.forEach((t) => {
    t.map.dispose()
    t.normal.dispose()
    t.rough.dispose()
  })
  textures.clear()
}

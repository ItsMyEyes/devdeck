import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Color, Object3D } from 'three'
import type {
  DirectionalLight,
  HemisphereLight,
  InstancedMesh,
  Group,
} from 'three'
import {
  box,
  sphere,
  material,
} from '@/features/agent-workspace/officePrimitives'
import {
  daylightAt,
  QualityController,
  qualitySettings,
} from '@/features/agent-workspace/sceneSettings'
import type {
  OfficeEnvironment as Environment,
  QualityPreference,
  QualityTier,
} from '@/features/agent-workspace/sceneSettings'

export function OfficeLighting({
  visible,
  reduced,
  tier,
  onPeriod,
}: {
  visible: boolean
  reduced: boolean
  tier: QualityTier
  onPeriod: (period: string) => void
}) {
  const sun = useRef<DirectionalLight>(null),
    fill = useRef<HemisphereLight>(null)
  const { scene, invalidate } = useThree()
  const current = useRef(daylightAt(new Date()))
  const [clock, setClock] = useState(current.current)
  const colors = useMemo(
    () => ({
      background: new Color(),
      sun: new Color(),
      dayBackground: new Color('#dce8e1'),
      daySun: new Color('#fff7dd'),
      daySky: new Color('#e8f3ed'),
    }),
    [],
  )
  useEffect(() => {
    if (!visible) return
    const update = () => {
      setClock(daylightAt(new Date()))
      invalidate()
    }
    update()
    const timer = setInterval(update, 30000)
    return () => clearInterval(timer)
  }, [visible, invalidate])
  useEffect(() => {
    onPeriod(clock.period)
  }, [clock.period, onPeriod])
  useFrame((_, delta) => {
    const blend = reduced ? 1 : 1 - Math.exp(-Math.min(delta, 0.1) * 2)
    current.current.sun += (clock.sun - current.current.sun) * blend
    current.current.night += (clock.night - current.current.night) * blend
    if (
      visible &&
      !reduced &&
      (Math.abs(clock.sun - current.current.sun) > 0.002 ||
        Math.abs(clock.night - current.current.night) > 0.002)
    )
      invalidate()
    const daylight = current.current.sun,
      night = current.current.night
    colors.background.set('#203341').lerp(colors.dayBackground, daylight)
    if (scene.background instanceof Color)
      scene.background.copy(colors.background)
    if (sun.current) {
      colors.sun.set('#efc496').lerp(colors.daySun, daylight)
      sun.current.color.copy(colors.sun)
      sun.current.intensity = 0.7 + daylight * 1.75
      sun.current.position.set(
        Math.cos(clock.angle) * 12,
        8 + daylight * 12,
        -12,
      )
    }
    if (fill.current) {
      fill.current.intensity = 1.5 + daylight * 0.1
      fill.current.color.set('#7697c7').lerp(colors.daySky, 1 - night)
    }
  })
  return (
    <>
      <color attach="background" args={['#dce8e1']} />
      <hemisphereLight ref={fill} args={['#e8f3ed', '#827261', 1.2]} />
      <directionalLight
        ref={sun}
        position={[2, 18, -12]}
        intensity={2}
        castShadow={qualitySettings[tier].shadows}
        shadow-mapSize={[
          qualitySettings[tier].shadowSize,
          qualitySettings[tier].shadowSize,
        ]}
        shadow-camera-left={-35}
        shadow-camera-right={35}
        shadow-camera-top={35}
        shadow-camera-bottom={-35}
        shadow-normalBias={0.04}
        shadow-bias={-0.0002}
      />
    </>
  )
}
function Repeated({
  items,
  color,
  round = false,
  emissive = false,
}: {
  items: [number, number, number, number, number, number][]
  color: string
  round?: boolean
  emissive?: boolean
}) {
  const ref = useRef<InstancedMesh>(null)
  const surface = material(color, emissive ? 'screen' : 'generic')
  useEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    const transform = new Object3D()
    items.forEach(([x, y, z, w, h, d], i) => {
      transform.position.set(x, y, z)
      transform.scale.set(w, h, d)
      transform.updateMatrix()
      mesh.setMatrixAt(i, transform.matrix)
    })
    mesh.instanceMatrix.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [items])
  return (
    <instancedMesh
      ref={ref}
      args={[round ? sphere : box, surface, items.length]}
      receiveShadow
    />
  )
}
export default function OfficeEnvironment({
  kind,
  minX,
  maxX,
  minZ,
  night,
  visible = true,
  reduced = false,
  decorativeMotion = false,
}: {
  visible?: boolean
  reduced?: boolean
  decorativeMotion?: boolean
  kind: Environment
  minX: number
  maxX: number
  minZ: number
  night: boolean
}) {
  const foliage = useRef<Group>(null)
  useFrame(({ clock }) => {
    if (foliage.current)
      foliage.current.rotation.z =
        visible && !reduced && decorativeMotion
          ? Math.sin(clock.elapsedTime * 0.4) * 0.003
          : 0
  })
  const objects = useMemo(() => {
    const trunks: [number, number, number, number, number, number][] = [],
      crowns: typeof trunks = [],
      buildings: typeof trunks = [],
      windows: typeof trunks = []
    for (let i = 0; i < 24; i++) {
      const x = minX - 9 + (i * (maxX - minX + 18)) / 23,
        z = minZ - 5 - (i % 3) * 6,
        height = 3 + ((i * 7) % 9) * 0.6
      trunks.push([x, 0.9, z, 0.18, 1.8, 0.18])
      crowns.push([x, 2.7 + (i % 3) * 0.3, z, 1.4, 2 + (i % 3) * 0.4, 1.3])
      buildings.push([x, height / 2, z - 8, 2.2, height, 2.5])
      for (let y = 1; y < height - 0.4; y += 1)
        for (let c = 0; c < 2; c++)
          windows.push([x - 0.55 + c * 1.1, y, z - 6.73, 0.38, 0.32, 0.02])
    }
    return { trunks, crowns, buildings, windows }
  }, [minX, maxX, minZ])
  return (
    <group name={`office-environment:${kind}`}>
      <mesh
        position={[(minX + maxX) / 2, -0.5, minZ - 13]}
        scale={[maxX - minX + 35, 0.4, 25]}
        geometry={box}
        material={material(kind === 'garden' ? '#84977a' : '#73828a')}
        receiveShadow
      />
      {kind === 'garden' ? (
        <>
          <Repeated items={objects.trunks} color="#82684e" />
          <group ref={foliage}>
            <Repeated items={objects.crowns} color="#648768" round />
          </group>
          <Repeated
            items={objects.crowns.map(([x, y, z, w, h, d]) => [
              x + 1,
              y - 0.6,
              z - 6,
              w * 1.6,
              h * 0.7,
              d * 1.4,
            ])}
            color="#92a184"
            round
          />
        </>
      ) : (
        <>
          <Repeated items={objects.buildings} color="#71828d" />
          <Repeated
            items={objects.windows}
            color={night ? '#e5bd7d' : '#9bbbc7'}
            emissive={night}
          />
        </>
      )}
    </group>
  )
}
export function QualityMonitor({
  preference,
  visible,
  reduced,
  onTier,
}: {
  preference: QualityPreference
  visible: boolean
  reduced: boolean
  onTier: (tier: QualityTier) => void
}) {
  const controller = useRef(new QualityController())
  const last = useRef<QualityTier>('balanced')
  useEffect(() => {
    controller.current.reset()
  }, [visible, preference, reduced])
  useFrame((_, delta) => {
    if (!visible || reduced || preference !== 'auto') return
    const tier = controller.current.sample(delta)
    if (tier !== last.current) {
      last.current = tier
      onTier(tier)
      if (import.meta.env.DEV) console.debug('[office-quality]', tier)
    }
  })
  return null
}

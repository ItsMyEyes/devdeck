import { useEffect, useMemo, useRef, useState } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { Color, FogExp2, Group } from 'three'
import type { DirectionalLight, HemisphereLight } from 'three'
import {
  createCity,
  CityMotion,
  fitCity,
} from '@/features/agent-workspace/city'
import type { CityBounds } from '@/features/agent-workspace/city'
import { createCityScene } from '@/features/agent-workspace/cityRenderer'
import {
  daylightAt,
  QualityController,
  qualitySettings,
} from '@/features/agent-workspace/sceneSettings'
import type {
  QualityPreference,
  QualityTier,
} from '@/features/agent-workspace/sceneSettings'

// Reference palette; intensity compensates for the installed Three.js physical lights.
const moods = {
  morning: { sky: '#ece9df', sun: '#ffeed5', fill: 0.8, direct: 0.85 },
  day: { sky: '#ebe5d8', sun: '#fff4dd', fill: 0.85, direct: 1 },
  evening: { sky: '#e0c6ae', sun: '#ffc185', fill: 0.6, direct: 0.55 },
  night: { sky: '#28374a', sun: '#aec6ed', fill: 0.48, direct: 0.24 },
}
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
  const [clock, setClock] = useState(() => daylightAt(new Date()))
  const colors = useMemo(() => ({ sky: new Color(), sun: new Color() }), [])
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
    const mood = moods[clock.period as keyof typeof moods]
    const blend = reduced ? 1 : 1 - Math.exp(-Math.min(delta, 0.1) * 2)
    colors.sky.set(mood.sky)
    colors.sun.set(mood.sun)
    if (scene.background instanceof Color) {
      scene.background.lerp(colors.sky, blend)
      if (scene.fog instanceof FogExp2) scene.fog.color.copy(scene.background)
    }
    if (sun.current) {
      sun.current.color.lerp(colors.sun, blend)
      sun.current.intensity +=
        (mood.direct * Math.PI - sun.current.intensity) * blend
    }
    if (fill.current)
      fill.current.intensity +=
        (mood.fill * Math.PI - fill.current.intensity) * blend
  })
  return (
    <>
      <color
        attach="background"
        args={[moods[clock.period as keyof typeof moods].sky]}
      />
      <hemisphereLight
        ref={fill}
        args={['#ffffff', '#d9d2c3', 0.85 * Math.PI]}
      />
      <directionalLight
        ref={sun}
        position={[-12, 55, 25]}
        intensity={Math.PI}
        castShadow={qualitySettings[tier].shadows}
        shadow-mapSize={[
          qualitySettings[tier].shadowSize,
          qualitySettings[tier].shadowSize,
        ]}
        shadow-camera-left={-45}
        shadow-camera-right={45}
        shadow-camera-top={55}
        shadow-camera-bottom={-40}
        shadow-camera-far={130}
        shadow-normalBias={0.04}
        shadow-bias={-0.0002}
      />
    </>
  )
}

export default function OfficeEnvironment({
  bounds,
  visible,
  reduced,
  tier,
}: {
  bounds: CityBounds
  visible: boolean
  reduced: boolean
  tier: QualityTier
}) {
  const host = useRef<Group>(null)
  const city = useMemo(createCity, [])
  const motion = useMemo(() => new CityMotion(city), [city])
  const rendered = useRef<ReturnType<typeof createCityScene> | null>(null)
  const { scene, invalidate } = useThree()
  const fit = fitCity(bounds)
  useEffect(() => {
    const value = createCityScene(city)
    rendered.current = value
    host.current?.add(value.group)
    invalidate()
    return () => {
      rendered.current = null
      value.group.removeFromParent()
      value.dispose()
    }
  }, [city, invalidate])
  useEffect(() => {
    const prior = scene.fog
    scene.fog = new FogExp2('#ebe5d8', 0.003 / fit.scale)
    return () => {
      scene.fog = prior
    }
  }, [scene, fit.scale])
  useEffect(() => {
    rendered.current?.update(motion, tier)
    invalidate()
  }, [tier, motion, invalidate])
  useFrame((_, delta) => {
    if (motion.tick(delta, visible, reduced, tier))
      rendered.current?.update(motion, tier)
  })
  return (
    <group
      ref={host}
      name="office-city-root"
      position={[fit.x, fit.y, fit.z]}
      scale={fit.scale}
      rotation={[0, fit.rotation, 0]}
    />
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

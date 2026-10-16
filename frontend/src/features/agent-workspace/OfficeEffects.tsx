import { Component, Suspense } from 'react'
import type { ReactNode } from 'react'
import { Environment } from '@react-three/drei'
import {
  Bloom,
  EffectComposer,
  N8AO,
  ToneMapping,
} from '@react-three/postprocessing'
import { ToneMappingMode } from 'postprocessing'
import { assetUrl } from '@/features/agent-workspace/interiorAssets'
import type { QualityTier } from '@/features/agent-workspace/sceneSettings'

class EnvironmentFallback extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch() {
    if (import.meta.env.DEV)
      console.debug('[office-assets] environment fallback')
  }
  render() {
    return this.state.failed ? null : this.props.children
  }
}
export default function OfficeEffects({
  tier,
  night = false,
}: {
  tier: QualityTier
  night?: boolean
}) {
  return (
    <>
      {tier !== 'low' && (
        <EnvironmentFallback>
          <Suspense fallback={null}>
            <Environment
              files={assetUrl('env/studio_small_09_1k.hdr')}
              background={false}
              environmentIntensity={night ? 0.12 : 0.3}
            />
          </Suspense>
        </EnvironmentFallback>
      )}
      {tier === 'high' && (
        <EffectComposer multisampling={0}>
          <N8AO
            halfRes
            quality="performance"
            aoRadius={0.3}
            distanceFalloff={0.8}
            intensity={1.1}
          />
          <Bloom
            mipmapBlur
            intensity={0.15}
            luminanceThreshold={1.5}
            luminanceSmoothing={0.3}
          />
          <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
        </EffectComposer>
      )}
    </>
  )
}

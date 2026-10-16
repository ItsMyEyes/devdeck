import { useContext, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import type { Group } from 'three'
import type { Actor } from '@/features/agent-workspace/activity'
import {
  Block,
  InteriorQuality,
} from '@/features/agent-workspace/officePrimitives'
import { facePose } from '@/features/agent-workspace/facePose'

export default function OfficeFace({
  actor,
  seed,
  reduced,
}: {
  actor: Actor
  seed: number
  reduced: boolean
}) {
  const tier = useContext(InteriorQuality)
  const eyes = useRef<Group>(null),
    left = useRef<Group>(null),
    right = useRef<Group>(null),
    mouth = useRef<Group>(null)
  const time = useRef(0)
  useFrame((_, dt) => {
    time.current += Math.min(dt, 0.1)
    const pose = facePose(
      actor.intent,
      seed,
      time.current,
      reduced || tier === 'low',
    )
    if (eyes.current) eyes.current.scale.y = pose.eye
    if (left.current) left.current.rotation.z = pose.brow
    if (right.current) right.current.rotation.z = -pose.brow
    if (mouth.current) mouth.current.rotation.z = pose.mouth
  })
  return (
    <group position={[0, 0, -0.132]}>
      <group ref={eyes} position={[0, 0.025, 0]}>
        {[-1, 1].map((n) => (
          <group key={n} position={[n * 0.055, 0, 0]}>
            <Block
              at={[0, 0, 0]}
              size={[0.038, 0.046, 0.014]}
              color="#f8f1e5"
              soft
            />
            <Block
              at={[0, -0.002, -0.01]}
              size={[0.018, 0.029, 0.008]}
              color="#26343a"
              soft
            />
          </group>
        ))}
      </group>
      <group ref={left} position={[-0.055, 0.07, -0.001]}>
        <Block
          at={[0, 0, 0]}
          size={[0.045, 0.012, 0.012]}
          color="#4b352c"
          soft
        />
      </group>
      <group ref={right} position={[0.055, 0.07, -0.001]}>
        <Block
          at={[0, 0, 0]}
          size={[0.045, 0.012, 0.012]}
          color="#4b352c"
          soft
        />
      </group>
      <Block
        at={[0, -0.016, -0.006]}
        size={[0.025, 0.027, 0.018]}
        color="#be8e74"
        soft
      />
      <group ref={mouth} position={[0, -0.065, 0]}>
        <Block
          at={[0, 0, 0]}
          size={[0.05, 0.012, 0.008]}
          color="#87554b"
          soft
        />
      </group>
    </group>
  )
}

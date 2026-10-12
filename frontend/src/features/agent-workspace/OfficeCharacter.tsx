import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { MathUtils, Quaternion, Vector3 } from 'three'
import type { Group } from 'three'
import {
  Block,
  cylinder,
  material,
} from '@/features/agent-workspace/officePrimitives'
import {
  characterPose,
  makePose,
} from '@/features/agent-workspace/characterPose'
import { seedFor } from '@/features/agent-workspace/activity'
import type { Actor } from '@/features/agent-workspace/activity'
const shirts = ['#548d87', '#b77858', '#717bab', '#ab8675', '#64839d']
const skins = ['#d0a583', '#a87b5f', '#ebc4a2', '#8c624b']
export default function OfficeCharacter({
  actor,
  reduced,
  color,
}: {
  actor: Actor
  reduced: boolean
  color?: string
}) {
  const joints = useRef<Record<string, Group | null>>({})
  const pose = useRef(makePose())
  const h = seedFor(actor.key),
    skin = skins[h % skins.length],
    shirt = color || shirts[h % shirts.length]
  const ref = (name: string) => (group: Group | null) => {
    joints.current[name] = group
  }
  const vectors = useRef({
    shoulder: new Vector3(),
    target: new Vector3(),
    direction: new Vector3(),
    pole: new Vector3(),
    elbow: new Vector3(),
    previousUpper: new Quaternion(),
    previousLower: new Quaternion(),
    upper: new Quaternion(),
    lower: new Quaternion(),
    down: new Vector3(0, -1, 0),
  })
  const apply = (delta = 0) => {
    const p = characterPose(actor, reduced, pose.current),
      j = joints.current
    const blend = delta && !reduced ? 1 - Math.exp(-delta * 9) : 1
    if (j.body) {
      j.body.position.y = MathUtils.lerp(j.body.position.y, p.height, blend)
      j.body.rotation.z = MathUtils.lerp(j.body.rotation.z, p.roll, blend)
    }
    if (j.torso)
      j.torso.rotation.x = MathUtils.lerp(j.torso.rotation.x, p.torso, blend)
    if (j.head) {
      j.head.rotation.x = MathUtils.lerp(j.head.rotation.x, p.head, blend)
      j.head.rotation.y = MathUtils.lerp(j.head.rotation.y, p.headYaw, blend)
    }
    for (let i = 0; i < 2; i++) {
      const previous = vectors.current
      if (j[`shoulder${i}`])
        previous.previousUpper.copy(j[`shoulder${i}`]!.quaternion)
      if (j[`elbow${i}`])
        previous.previousLower.copy(j[`elbow${i}`]!.quaternion)
      if (j[`shoulder${i}`]) {
        j[`shoulder${i}`]!.rotation.x = p.shoulders[i]
        j[`shoulder${i}`]!.rotation.z = p.spread[i]
      }
      if (j[`elbow${i}`]) j[`elbow${i}`]!.rotation.x = p.elbows[i]
      if (p.targets && j[`shoulder${i}`] && j[`elbow${i}`] && j[`hand${i}`]) {
        const v = vectors.current
        v.shoulder.set(i ? 0.29 : -0.29, 0.51, 0)
        v.target.fromArray(p.targets[i])
        v.direction.subVectors(v.target, v.shoulder)
        const length = Math.min(0.549, Math.max(0.02, v.direction.length()))
        v.direction.normalize()
        const along = (0.28 ** 2 - 0.27 ** 2 + length ** 2) / (2 * length)
        v.pole
          .set(i ? 1 : -1, -0.4, 0.2)
          .addScaledVector(v.direction, -v.pole.dot(v.direction))
          .normalize()
        v.elbow
          .copy(v.shoulder)
          .addScaledVector(v.direction, along)
          .addScaledVector(
            v.pole,
            Math.sqrt(Math.max(0, 0.28 ** 2 - along ** 2)),
          )
        v.upper.setFromUnitVectors(
          v.down,
          v.pole.subVectors(v.elbow, v.shoulder).normalize(),
        )
        v.lower.setFromUnitVectors(
          v.down,
          v.pole.subVectors(v.target, v.elbow).normalize(),
        )
        j[`shoulder${i}`]!.quaternion.copy(v.previousUpper).slerp(
          v.upper,
          blend,
        )
        j[`elbow${i}`]!.quaternion.copy(v.previousLower).slerp(
          v.upper.invert().multiply(v.lower),
          blend,
        )
        j[`hand${i}`]!.quaternion.copy(v.lower.invert())
        j[`hand${i}`]!.rotation.x += p.hand[i]
      } else if (j[`hand${i}`]) j[`hand${i}`]!.rotation.x = p.hand[i]
      if (j[`hip${i}`]) j[`hip${i}`]!.rotation.x = p.hips[i]
      if (j[`knee${i}`]) j[`knee${i}`]!.rotation.x = p.knees[i]
    }
    if (j.book)
      j.book.position.set(
        0.4 * (1 - p.propMix),
        0.37 - 0.14 * p.propMix,
        -0.35 - 0.13 * p.propMix,
      )
    if (j.guitar)
      j.guitar.position.set(
        0.6 * (1 - p.propMix),
        0.12,
        -0.35 - 0.02 * p.propMix,
      )
    for (const name of ['book', 'guitar', 'cup', 'kettle', 'water'])
      if (j[name])
        j[name]!.visible =
          name === p.prop ||
          (p.prop === 'tea' && (name === 'cup' || name === 'kettle'))
  }
  useFrame((_, delta) => apply(delta))
  return (
    <group
      ref={(group) => {
        joints.current.body = group
        if (group) apply()
      }}
      position={[0, 0.57, 0]}
    >
      <Block at={[0, 0, 0]} size={[0.43, 0.2, 0.3]} color="#354454" />
      {[0, 1].map((i) => (
        <group
          key={i}
          ref={ref(`hip${i}`)}
          position={[i ? 0.14 : -0.14, 0, 0]}
          rotation={[1.45, 0, 0]}
        >
          <Block at={[0, -0.19, 0]} size={[0.17, 0.38, 0.19]} color="#354454" />
          <group
            ref={ref(`knee${i}`)}
            position={[0, -0.38, 0]}
            rotation={[-1.45, 0, 0]}
          >
            <Block
              at={[0, -0.225, 0]}
              size={[0.16, 0.45, 0.17]}
              color="#354454"
            />
            <Block
              at={[0, -0.455, -0.08]}
              size={[0.19, 0.13, 0.32]}
              color="#29343d"
            />
          </group>
        </group>
      ))}
      <group ref={ref('torso')}>
        <Block at={[0, 0.29, 0]} size={[0.48, 0.58, 0.32]} color={shirt} />
        <group ref={ref('head')} position={[0, 0.75, 0]}>
          <Block at={[0, 0, 0]} size={[0.25, 0.29, 0.23]} color={skin} round />
          <Block
            at={[0, 0.16, 0.035]}
            size={[0.27, 0.18, 0.25]}
            color="#34302e"
            round
          />
          {h % 3 === 0 && (
            <Block
              at={[0.08, 0.22, 0.13]}
              size={[0.15, 0.15, 0.15]}
              color="#34302e"
              round
            />
          )}
          {[-1, 1].map((n) => (
            <Block
              key={n}
              at={[n * 0.083, 0.02, -0.215]}
              size={[0.028, 0.035, 0.022]}
              color="#333638"
            />
          ))}
        </group>
        {[0, 1].map((i) => (
          <group
            key={i}
            ref={ref(`shoulder${i}`)}
            position={[i ? 0.29 : -0.29, 0.51, 0]}
            rotation={[0.56, 0, i ? -0.05 : 0.05]}
          >
            <Block at={[0, -0.14, 0]} size={[0.15, 0.28, 0.16]} color={shirt} />
            <group
              ref={ref(`elbow${i}`)}
              position={[0, -0.28, 0]}
              rotation={[1.16, 0, 0]}
            >
              <Block
                at={[0, -0.13, 0]}
                size={[0.12, 0.26, 0.13]}
                color={skin}
              />
              <group ref={ref(`hand${i}`)} position={[0, -0.27, 0]}>
                <Block
                  at={[0, -0.025, -0.015]}
                  size={[0.12, 0.09, 0.14]}
                  color={skin}
                  round
                />
                {i === 0 && (
                  <group
                    ref={ref('kettle')}
                    visible={false}
                    position={[0, -0.05, -0.05]}
                  >
                    <mesh
                      geometry={cylinder}
                      material={material('#b8bec0')}
                      scale={[0.11, 0.2, 0.11]}
                    />
                    <Block
                      at={[0.13, 0.02, 0]}
                      size={[0.15, 0.05, 0.06]}
                      color="#b8bec0"
                    />
                  </group>
                )}
                {i === 1 && (
                  <>
                    <group
                      ref={ref('cup')}
                      visible={false}
                      position={[0, -0.04, -0.05]}
                    >
                      <mesh
                        geometry={cylinder}
                        material={material('#e6daca')}
                        scale={[0.07, 0.16, 0.07]}
                      />
                      <Block
                        at={[0.08, 0, 0]}
                        size={[0.06, 0.1, 0.03]}
                        color="#bfa98e"
                      />
                    </group>
                    <group
                      ref={ref('water')}
                      visible={false}
                      position={[0, -0.06, -0.05]}
                      rotation={[0, 0, -0.3]}
                    >
                      <Block
                        at={[0, 0, 0]}
                        size={[0.24, 0.22, 0.18]}
                        color="#839ba2"
                      />
                      <Block
                        at={[-0.2, 0.02, 0]}
                        size={[0.25, 0.06, 0.06]}
                        color="#839ba2"
                      />
                    </group>
                  </>
                )}
              </group>
            </group>
          </group>
        ))}
        <group
          ref={ref('book')}
          visible={false}
          position={[0, 0.23, -0.48]}
          rotation={[0.35, 0, 0]}
        >
          <Block at={[0, 0, 0]} size={[0.5, 0.05, 0.32]} color="#a87559" />
          <Block at={[0, 0.035, 0]} size={[0.46, 0.025, 0.3]} color="#e5dfce" />
          <Block at={[0, 0.055, 0]} size={[0.015, 0.03, 0.3]} color="#bfae90" />
        </group>
        <group
          ref={ref('guitar')}
          visible={false}
          position={[0, 0.12, -0.37]}
          rotation={[0.1, 0, -0.6]}
        >
          <Block
            at={[0, 0, 0]}
            size={[0.23, 0.32, 0.08]}
            color="#b8864e"
            round
          />
          <Block
            at={[0, 0.15, 0]}
            size={[0.16, 0.23, 0.08]}
            color="#b8864e"
            round
          />
          <Block
            at={[0, 0.04, -0.08]}
            size={[0.07, 0.07, 0.02]}
            color="#453832"
            round
          />
          <Block at={[0, 0.42, 0]} size={[0.07, 0.55, 0.05]} color="#654d3b" />
          <Block
            at={[0, 0.35, -0.035]}
            size={[0.028, 0.64, 0.005]}
            color="#d6c3a0"
          />
        </group>
      </group>
    </group>
  )
}

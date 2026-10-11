import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Html } from '@react-three/drei'
import type { Group } from 'three'
import {
  Block,
  cylinder,
  material,
} from '@/features/agent-workspace/officePrimitives'
import type {
  ActivityWorld,
  FloorPlan,
  Slot,
} from '@/features/agent-workspace/activity'

function RestingProp({ slot, world }: { slot: Slot; world: ActivityWorld }) {
  const root = useRef<Group>(null)
  useFrame(() => {
    const actor = world.actors.get(world.reservations.get(slot.id) || '')
    if (root.current) root.current.visible = !actor || actor.interaction < 0.45
  })
  return (
    <group
      ref={root}
      position={
        slot.activity === 'book' || slot.activity === 'drink'
          ? [0.4, 0.96, -0.35]
          : slot.activity === 'guitar'
            ? [0.6, 0.57, -0.35]
            : [0.1, 1.03, -0.4]
      }
    >
      {slot.activity === 'guitar' ? (
        <group position={[0, 0, 0]} rotation={[0, 0, -0.3]}>
          <Block at={[0, 0, 0]} size={[0.3, 0.4, 0.1]} color="#b8864e" round />
          <Block at={[0, 0.38, 0]} size={[0.08, 0.5, 0.05]} color="#654d3b" />
        </group>
      ) : slot.activity === 'tea' ? (
        <>
          <mesh
            geometry={cylinder}
            material={material('#e6daca')}
            scale={[0.07, 0.16, 0.07]}
          />
          <mesh
            position={[-0.35, 0.12, -0.05]}
            geometry={cylinder}
            material={material('#b8bec0')}
            scale={[0.11, 0.2, 0.11]}
          />
          <Block
            at={[-0.22, 0.14, -0.05]}
            size={[0.15, 0.05, 0.06]}
            color="#b8bec0"
          />
        </>
      ) : slot.activity === 'book' ? (
        <Block at={[0, 0, 0]} size={[0.48, 0.06, 0.32]} color="#a87559" />
      ) : slot.activity === 'plant' ? (
        <Block at={[0.45, -0.1, 0]} size={[0.23, 0.22, 0.18]} color="#839ba2" />
      ) : (
        <mesh
          geometry={cylinder}
          material={material('#e6daca')}
          scale={[0.07, 0.16, 0.07]}
        />
      )}
    </group>
  )
}

export default function OfficeLounge({
  plan,
  dark,
  world,
}: {
  plan: FloorPlan
  dark: boolean
  world: ActivityWorld
}) {
  const accent = dark ? '#547570' : '#81a795'
  return (
    <group>
      {plan.slots.map((slot) => (
        <group
          key={slot.id}
          position={[
            slot.point[0],
            0,
            slot.point[1] - (slot.seated ? 0.45 : 0),
          ]}
        >
          <Block
            at={[0, 0.05, -0.3]}
            size={[3.6, 0.025, 2.1]}
            color={dark ? '#3e5352' : '#c4d4c8'}
          />
          {slot.activity === 'sofa' ? (
            <>
              <Block
                at={[0, 0.42, -0.22]}
                size={[3, 0.36, 1.2]}
                color={accent}
              />
              <Block
                at={[0, 0.86, -0.73]}
                size={[3, 0.65, 0.2]}
                color={accent}
              />
              {[-1.4, 1.4].map((x) => (
                <Block
                  key={x}
                  at={[x, 0.7, -0.22]}
                  size={[0.2, 0.65, 1.2]}
                  color={accent}
                />
              ))}
              <Block
                at={[0.7, 0.66, -0.1]}
                size={[0.55, 0.12, 0.6]}
                color="#d9be9a"
              />
            </>
          ) : slot.activity === 'beanbag' ? (
            <>
              <Block
                at={[0, 0.28, -0.1]}
                size={[0.72, 0.25, 0.72]}
                color="#b99474"
                round
              />
              <Block
                at={[0, 0.55, -0.55]}
                size={[0.65, 0.4, 0.35]}
                color="#b99474"
                round
              />
            </>
          ) : slot.activity === 'coffee' || slot.activity === 'tea' ? (
            <>
              <Block
                at={[0, 0.44, -0.85]}
                size={[1.5, 0.88, 0.7]}
                color="#aa8f70"
              />
              <Block
                at={[0, 0.9, -0.85]}
                size={[1.6, 0.08, 0.8]}
                color="#dfd6bf"
              />
              {slot.activity === 'coffee' ? (
                <>
                  <Block
                    at={[-0.25, 1.15, -0.85]}
                    size={[0.45, 0.45, 0.4]}
                    color="#42565a"
                  />
                  <Block
                    at={[-0.25, 1.24, -0.625]}
                    size={[0.23, 0.09, 0.025]}
                    color="#9fc3bd"
                  />
                  <Block
                    at={[-0.25, 1.04, -0.55]}
                    size={[0.18, 0.04, 0.2]}
                    color="#29343d"
                  />
                </>
              ) : (
                <>
                  <Block
                    at={[0.4, 1.02, -0.8]}
                    size={[0.25, 0.14, 0.24]}
                    color="#8ba691"
                  />
                </>
              )}
              <RestingProp slot={slot} world={world} />
            </>
          ) : slot.activity === 'plant' ? (
            <>
              <mesh
                position={[0, 0.3, -0.75]}
                geometry={cylinder}
                material={material('#b59e88')}
                scale={[0.25, 0.5, 0.25]}
              />
              <Block
                at={[0, 0.75, -0.75]}
                size={[0.04, 0.7, 0.04]}
                color="#67775b"
              />
              {[-1, 1].map((n) => (
                <Block
                  key={n}
                  at={[n * 0.2, 0.93, -0.75]}
                  size={[0.4, 0.4, 0.2]}
                  color="#7d9873"
                  round
                />
              ))}
              <RestingProp slot={slot} world={world} />
            </>
          ) : slot.activity === 'stretch' ? (
            <Block at={[0, 0.08, 0]} size={[1.25, 0.04, 1.8]} color="#8298b0" />
          ) : (
            <>
              <Block
                at={[0, 0.48, 0]}
                size={[0.75, 0.12, 0.7]}
                color={accent}
              />
              <Block
                at={[0, 0.9, 0.3]}
                size={[0.75, 0.7, 0.12]}
                color={accent}
              />
              <Block
                at={[0, 0.24, 0]}
                size={[0.1, 0.48, 0.1]}
                color="#526368"
              />
              <Block
                at={[0.55, 0.9, -0.35]}
                size={[0.7, 0.06, 0.65]}
                color="#aa8f70"
              />
              <RestingProp slot={slot} world={world} />
            </>
          )}
          <Html position={[0, 1.9, -0.85]} center zIndexRange={[1, 0]}>
            <span className="office-room-label">
              {
                {
                  sofa: 'Sofa',
                  beanbag: 'Beanbag',
                  coffee: 'Coffee',
                  tea: 'Tea',
                  drink: 'Break',
                  guitar: 'Music',
                  book: 'Reading',
                  stretch: 'Stretch',
                  plant: 'Garden',
                }[slot.activity]
              }
            </span>
          </Html>
        </group>
      ))}
    </group>
  )
}

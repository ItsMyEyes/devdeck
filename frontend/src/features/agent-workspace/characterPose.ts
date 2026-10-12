import type { Actor } from '@/features/agent-workspace/activity'
export interface Pose {
  propMix: number
  height: number
  roll: number
  targets?: [[number, number, number], [number, number, number]]
  torso: number
  head: number
  headYaw: number
  shoulders: [number, number]
  elbows: [number, number]
  hips: [number, number]
  knees: [number, number]
  spread: [number, number]
  hand: [number, number]
  prop: 'none' | 'book' | 'guitar' | 'cup' | 'tea' | 'water'
}
export function makePose(): Pose {
  return {
    propMix: 1,
    height: 0.57,
    roll: 0,
    torso: 0,
    head: 0,
    headYaw: 0,
    shoulders: [0.4, 0.4],
    elbows: [1.25, 1.25],
    hips: [1.4, 1.4],
    knees: [-1.4, -1.4],
    spread: [0.05, -0.05],
    hand: [0, 0],
    prop: 'none',
  }
}
export function characterPose(
  actor: Actor,
  reduced: boolean,
  pose: Pose,
): Pose {
  const t = reduced ? 0 : actor.time,
    seed = actor.random % 97
  const walking = actor.phase === 'approach' || actor.phase === 'return'
  pose.height = actor.seated ? 0.57 : 0.9
  pose.propMix = Math.max(0, Math.min(1, (actor.interaction - 0.45) / 0.55))
  pose.roll = 0
  pose.targets = undefined
  pose.torso = 0
  pose.head = 0
  pose.headYaw = 0
  pose.prop = 'none'
  for (let side = 0; side < 2; side++) {
    pose.shoulders[side] = 0.1
    pose.elbows[side] = 0.15
    pose.spread[side] = side ? -0.05 : 0.05
    pose.hand[side] = 0
    pose.hips[side] = actor.seated ? 1.45 : 0
    pose.knees[side] = actor.seated ? -1.45 : 0.05
  }
  if (walking) {
    const gait = Math.sin(t * (actor.phase === 'return' ? 10 : 6)) * 0.42
    pose.hips[0] = gait
    pose.hips[1] = -gait
    pose.knees[0] = Math.min(0, -gait) * 0.8
    pose.knees[1] = Math.min(0, gait) * 0.8
    pose.shoulders[0] = -gait * 0.65
    pose.shoulders[1] = gait * 0.65
    pose.height += Math.abs(gait) * 0.035
    return pose
  }
  if (actor.phase === 'dwell') {
    if (actor.intent === 'work') {
      const cycle = (t + seed) % 13
      const reading = cycle > 9.5,
        trackpad = cycle > 7 && cycle < 9.5
      pose.torso = -0.13
      pose.head = -0.12
      pose.shoulders[0] = 0.56
      pose.shoulders[1] = trackpad ? 0.7 : 0.56
      pose.elbows[0] = 1.16
      pose.elbows[1] = 1.16
      if (!reading && !reduced) {
        pose.hand[0] = Math.max(0, Math.sin(t * 9 + seed)) * 0.045
        pose.hand[1] = Math.max(0, Math.sin(t * 9 + seed + Math.PI)) * 0.045
        pose.elbows[0] += pose.hand[0]
        pose.elbows[1] += pose.hand[1]
      }
      if (trackpad) pose.spread[1] = -0.3
      pose.targets = [
        [-0.19, 0.48 + pose.hand[0], -0.48],
        [trackpad ? 0.21 : 0.19, 0.48 + pose.hand[1], trackpad ? -0.3 : -0.48],
      ]
    } else if (actor.intent === 'attention') {
      pose.head = 0.16
      pose.torso = -0.05
      pose.shoulders[0] = 2.5
      pose.elbows[0] = -0.9
      pose.spread[0] = 0.3
      pose.shoulders[1] = 0.6
      pose.elbows[1] = 1.1
    } else if (actor.intent === 'error') {
      pose.head = -0.22
      pose.headYaw = Math.sin(t * 0.55 + seed) * 0.15
      pose.targets = [
        [-0.12, 0.65, -0.22],
        [0.2, 0.45, -0.45],
      ]
    } else {
      pose.head = -0.08
      pose.shoulders[0] = 0.45
      pose.elbows[0] = 1.2
    }
    return pose
  }
  if (actor.phase === 'cleanup' && actor.cleanupFrom === 0) return pose
  const activity = actor.activity
  const performing = actor.phase === 'perform'
  const motion = performing && !reduced ? Math.sin(t * 1.7 + seed) : 0
  // Props share the same hand-space coordinates in static and moving poses.
  if (activity === 'sofa') {
    pose.height = 0.74
    pose.roll = (Math.PI / 2) * actor.interaction
    pose.torso = 0.05
    pose.head = -0.15
    pose.hips[0] = 0.15
    pose.hips[1] = 0.2
    pose.knees[0] = -0.25
    pose.knees[1] = -0.3
    pose.spread[0] = 0.5
  }
  if (activity === 'beanbag') {
    pose.height = 0.5
    pose.torso = 0.25
    pose.hips[0] = 1.8
    pose.hips[1] = 1.6
    pose.knees[0] = -0.8
    pose.knees[1] = -1.1
  }
  if (activity === 'book') {
    pose.prop = 'book'
    pose.head = -0.25
    pose.shoulders[0] = 0.8
    pose.shoulders[1] = 0.8
    pose.elbows[0] = 1.15
    pose.elbows[1] = 1.15
    pose.spread[0] = -0.15
    pose.spread[1] = 0.15
    pose.hand[0] = motion * 0.04
    pose.targets = [
      [-0.19, 0.21, -0.45],
      [0.19, 0.21, -0.45],
    ]
  }
  if (activity === 'guitar') {
    pose.prop = 'guitar'
    pose.shoulders[0] = 0.65
    pose.shoulders[1] = 0.7
    pose.elbows[0] = 0.8
    pose.elbows[1] = 1.1 + motion * 0.1
    pose.spread[0] = -0.55
    pose.spread[1] = 0.35
    pose.head = -0.1
    pose.targets = [
      [-0.07 + motion * 0.025, 0.23, -0.41],
      [0.18, 0.5, -0.41],
    ]
  }
  if (activity === 'coffee' || activity === 'tea') {
    pose.prop = 'cup'
    pose.torso = -0.1
    pose.head = -0.18
    pose.shoulders[0] = 0.95
    pose.elbows[0] = 0.8
    pose.shoulders[1] = 0.7
    pose.elbows[1] = 1.25 + motion * 0.15
    pose.targets = [
      [
        -0.24,
        0.17 + Math.max(0, motion) * 0.16,
        -0.44 - Math.max(0, motion) * 0.12,
      ],
      [0.19, 0.2, -0.35],
    ]
    if (activity === 'tea') {
      pose.prop = 'tea'
      pose.targets[0] = [-0.2, 0.38, -0.42]
      pose.hand[0] = 0.6 + motion * 0.12
    }
  }
  if (activity === 'drink') {
    pose.prop = 'cup'
    const sip = reduced ? 1 : Math.max(0, Math.sin(t * 0.65 + seed))
    pose.shoulders[1] = 0.6 + sip * 0.45
    pose.elbows[1] = 1.25 + sip * 1.15
    pose.head = sip * 0.1
    pose.targets = [
      [-0.2, 0.08, -0.15],
      [0.2 - sip * 0.16, 0.23 + sip * 0.46, -0.4 + sip * 0.22],
    ]
  }
  if (activity === 'stretch') {
    pose.shoulders[0] = 2.9 + motion * 0.1
    pose.shoulders[1] = 2.9 - motion * 0.1
    pose.elbows[0] = 0.2
    pose.elbows[1] = 0.2
    pose.spread[0] = -0.25
    pose.spread[1] = 0.25
    pose.torso = motion * 0.1
  }
  if (activity === 'plant') {
    pose.prop = 'water'
    pose.torso = -0.18
    pose.shoulders[1] = 1.1
    pose.elbows[1] = 0.6 + motion * 0.08
    pose.head = -0.2
    pose.targets = [
      [-0.2, 0.12, -0.1],
      [0.2, 0.2, -0.44],
    ]
    pose.hand[1] = -0.3 + motion * 0.05
  }
  if (pose.targets && ['book', 'guitar'].includes(activity || '')) {
    const mix = pose.propMix
    const pickup: [[number, number, number], [number, number, number]] =
      activity === 'book'
        ? [
            [-0.16, 0.21, -0.4],
            [0.4, 0.42, -0.35],
          ]
        : [
            [-0.1, 0.23, -0.4],
            [0.45, 0.46, -0.35],
          ]
    for (let side = 0; side < 2; side++)
      for (let axis = 0; axis < 3; axis++)
        pose.targets[side][axis] =
          pickup[side][axis] * (1 - mix) + pose.targets[side][axis] * mix
  }
  if (actor.interaction < 0.45) pose.prop = 'none'
  return pose
}

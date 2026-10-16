import { expect, it } from 'vitest'
import { makeActor } from '@/features/agent-workspace/activity'
import {
  characterPose,
  makePose,
} from '@/features/agent-workspace/characterPose'

it('does not cycle semantic command poses on a decorative timer', () => {
  const actor = makeActor('command', [0, 0], 'work')
  actor.workKind = 'command'
  const start = characterPose(actor, false, makePose())
  actor.time = 8
  const later = characterPose(actor, false, makePose())
  expect(later.targets).toEqual(start.targets)
  expect(later.hand).toEqual([0, 0])
})
it('plants feet while blocked and advances gait with travelled distance', () => {
  const actor = makeActor('walking', [0, 0], 'idle')
  actor.phase = 'approach'
  actor.seated = false
  actor.travel = 0
  actor.speed = 0
  const blocked = characterPose(actor, false, makePose())
  actor.time = 20
  expect(characterPose(actor, false, makePose()).hips).toEqual(blocked.hips)
  actor.travel = 0.3
  actor.speed = 1
  expect(characterPose(actor, false, makePose()).hips).not.toEqual(blocked.hips)
})

it('types with independently moving hands and holds still for reduced motion', () => {
  const actor = makeActor('typing', [0, 0], 'work')
  actor.random = 0
  actor.time = 0.2
  const pose = characterPose(actor, false, makePose())
  expect(pose.targets![0][1]).not.toBe(pose.targets![1][1])
  const a = characterPose(actor, true, makePose())
  actor.time += 10
  expect(characterPose(actor, true, makePose())).toEqual(a)
})
it('does not pick up props while an approach is interrupted', () => {
  const actor = makeActor('tea', [0, 0], 'work')
  actor.activity = 'tea'
  actor.phase = 'cleanup'
  actor.cleanupFrom = 0
  expect(characterPose(actor, false, makePose()).prop).toBe('none')
})
it('keeps a held prop during put-down, then releases it at the resting handoff', () => {
  const actor = makeActor('book', [0, 0], 'idle')
  actor.activity = 'book'
  actor.phase = 'setup'
  actor.interaction = 0.2
  expect(characterPose(actor, false, makePose()).prop).toBe('none')
  actor.interaction = 1
  expect(characterPose(actor, false, makePose()).prop).toBe('book')
  actor.phase = 'cleanup'
  actor.cleanupFrom = 1
  actor.interaction = 0.7
  expect(characterPose(actor, false, makePose()).prop).toBe('book')
  actor.interaction = 0.2
  expect(characterPose(actor, false, makePose()).prop).toBe('none')
})
it('reclines along the sofa, sits low on a beanbag, and stands for stretching', () => {
  const actor = makeActor('rest', [0, 0], 'idle')
  actor.phase = 'perform'
  actor.interaction = 1
  actor.activity = 'sofa'
  const sofa = characterPose(actor, false, makePose())
  expect(sofa.roll).toBeGreaterThan(1)
  actor.activity = 'beanbag'
  expect(characterPose(actor, false, makePose()).height).toBeLessThan(
    sofa.height,
  )
  actor.activity = 'stretch'
  actor.seated = false
  expect(characterPose(actor, false, makePose()).height).toBeGreaterThan(
    sofa.height,
  )
})

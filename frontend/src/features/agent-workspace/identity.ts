export function seedFor(key: string) {
  let seed = 2166136261
  for (const c of key) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619)
  return seed >>> 0 || 1
}
const shirts = [
  '#548d87',
  '#b77858',
  '#717bab',
  '#ab8675',
  '#64839d',
  '#8b805e',
]
const skins = ['#d0a583', '#a87b5f', '#ebc4a2', '#8c624b']
const hair = ['#34302e', '#655045', '#ba9370', '#252b30']
const preferences = [
  'book',
  'plant',
  'coffee',
  'guitar',
  'stretch',
  'tea',
] as const
export function characterProfile(key: string) {
  const seed = seedFor(key)
  return {
    seed,
    shirt: shirts[seed % shirts.length],
    skin: skins[(seed >>> 4) % skins.length],
    hair: hair[(seed >>> 8) % hair.length],
    accessory: (seed >>> 12) % 3,
    posture: (((seed >>> 16) % 5) - 2) * 0.018,
    stride: 0.85 + ((seed >>> 20) % 5) * 0.05,
    preference: preferences[(seed >>> 24) % preferences.length],
    desk: (seed >>> 10) % 3,
  }
}

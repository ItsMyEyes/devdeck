export type QualityTier = 'high' | 'balanced' | 'low'
export type QualityPreference = 'auto' | QualityTier
export const qualitySettings = {
  high: { dpr: 1.5, shadows: true, shadowSize: 2048, decorativeMotion: true },
  balanced: {
    dpr: 1.25,
    shadows: true,
    shadowSize: 1024,
    decorativeMotion: true,
  },
  low: { dpr: 1, shadows: false, shadowSize: 512, decorativeMotion: false },
}
export function readQuality(workspace: string): QualityPreference {
  try {
    const value = localStorage.getItem(`devdeck.office-quality.${workspace}`)
    if (['high', 'balanced', 'low'].includes(value || ''))
      return value as QualityTier
  } catch {
    /* Optional preference. */
  }
  return 'auto'
}
export function daylightAt(date: Date) {
  const hour = date.getHours() + date.getMinutes() / 60
  const period =
    hour < 6 || hour >= 18
      ? 'night'
      : hour < 11
        ? 'morning'
        : hour < 15
          ? 'day'
          : 'evening'
  const sun = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI))
  return {
    period,
    sun,
    warmth: Math.max(0, 1 - sun),
    night: 1 - Math.min(1, sun * 5),
    angle: ((hour - 6) / 12) * Math.PI,
  }
}
export class QualityController {
  tier: QualityTier = 'balanced'
  private low = 0
  private high = 0
  private cooldown = 10
  private frames = 0
  private seconds = 0
  reset() {
    this.low = 0
    this.high = 0
    this.frames = 0
    this.seconds = 0
  }
  sample(delta: number) {
    if (!Number.isFinite(delta) || delta <= 0 || delta > 0.25) {
      this.reset()
      return this.tier
    }
    this.cooldown += delta
    this.frames++
    this.seconds += delta
    if (this.seconds < 1 - 1e-9) return this.tier
    const fps = this.frames / this.seconds
    this.low = fps < 35 ? this.low + this.seconds : 0
    this.high = fps > 50 ? this.high + this.seconds : 0
    this.frames = 0
    this.seconds = 0
    if (
      this.cooldown >= 10 &&
      ((this.low >= 5 - 1e-9 && this.tier !== 'low') ||
        (this.high >= 15 - 1e-9 && this.tier !== 'high'))
    ) {
      this.tier =
        this.low >= 5 - 1e-9
          ? this.tier === 'high'
            ? 'balanced'
            : 'low'
          : this.tier === 'low'
            ? 'balanced'
            : 'high'
      this.reset()
      this.cooldown = 0
    }
    return this.tier
  }
}

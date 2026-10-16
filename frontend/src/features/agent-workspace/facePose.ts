// Facial cues describe verified state; they never imply speech or task success.
export function facePose(
  intent: string,
  seed: number,
  seconds: number,
  staticFace: boolean,
) {
  const phase = (seconds + (seed % 300) / 100) % (3.6 + (seed % 15) / 10)
  const eye = staticFace
    ? 1
    : phase < 0.16
      ? Math.max(0.08, Math.abs(phase - 0.08) / 0.08)
      : 1
  return {
    eye,
    brow:
      intent === 'error'
        ? 0.28
        : intent === 'attention'
          ? -0.2
          : intent === 'work'
            ? 0.1
            : 0,
    mouth: intent === 'error' ? -0.12 : intent === 'attention' ? 0.08 : 0,
  }
}

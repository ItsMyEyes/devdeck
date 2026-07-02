interface LoomLogoProps {
  size?: number
  gap?: number
  radius?: number
}

/** The loom quad-square mark. */
export function LoomLogo({ size = 17, gap = 2, radius = 2 }: LoomLogoProps) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap,
        width: size,
        height: size,
      }}
    >
      <span style={{ background: 'var(--loom-accent)', borderRadius: radius }} />
      <span style={{ background: 'var(--loom-accent)', opacity: 0.45, borderRadius: radius }} />
      <span style={{ background: 'var(--loom-accent)', opacity: 0.45, borderRadius: radius }} />
      <span style={{ background: 'var(--loom-accent)', borderRadius: radius }} />
    </div>
  )
}

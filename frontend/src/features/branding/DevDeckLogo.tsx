interface DevDeckLogoProps {
  size?: number
  radius?: number
}

/** The DevDeck mark. */
export function DevDeckLogo({ size = 17, radius = 4 }: DevDeckLogoProps) {
  return (
    <img
      src="/devdeck-logo.png"
      alt="DevDeck"
      width={size}
      height={size}
      style={{ width: size, height: size, borderRadius: radius, objectFit: 'cover' }}
    />
  )
}

import { expect, it } from 'vitest'
import { appearanceItems } from '@/features/palette/providers/appearance'
import { readThemePreference } from '@/features/theme/theme'

it('offers and runs the theme commands from the palette', async () => {
  window.localStorage.clear()
  const items = appearanceItems('dark')
  expect(items.map((item) => item.title)).toEqual(['Appearance: Light', 'Appearance: Dark', 'Appearance: System'])
  const light = items.find((item) => item.id === 'appearance:light')!
  await light.run!({ wsId: '', leafId: '', showToast: () => {}, close: () => {} })
  expect(readThemePreference()).toBe('light')
})

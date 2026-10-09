import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AppearanceSetting } from '@/features/theme/AppearanceSetting'
import { readThemePreference, THEME_STORAGE_KEY } from '@/features/theme/theme'

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

it('switches among light, dark and system and persists the choice', async () => {
  const user = userEvent.setup()
  render(<AppearanceSetting />)
  expect(screen.getByRole('radio', { name: /dark/i })).toBeChecked()
  await user.click(screen.getByRole('radio', { name: /light/i }))
  expect(screen.getByRole('radio', { name: /light/i })).toBeChecked()
  expect(readThemePreference()).toBe('light')
  await user.click(screen.getByRole('radio', { name: /system/i }))
  expect(screen.getByRole('radio', { name: /system/i })).toBeChecked()
  cleanup()
  render(<AppearanceSetting />)
  expect(screen.getByRole('radio', { name: /system/i })).toBeChecked()
  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system')
})

import { Monitor, Moon, Sun } from 'lucide-react'
import { setThemePreference } from '@/features/theme/theme'
import type { ThemePreference } from '@/features/theme/theme'
import type { PaletteItem } from '@/features/palette/paletteTypes'

export function appearanceItems(current: ThemePreference): PaletteItem[] {
  return ([
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'system', label: 'System', icon: Monitor },
  ] as const).map(({ value, label, icon }) => ({
    id: `appearance:${value}`,
    kind: 'command',
    group: 'create',
    title: `Appearance: ${label}`,
    subtitle: current === value ? 'Current theme' : value === 'system' ? 'Follow your device' : `Switch to ${label.toLowerCase()} theme`,
    keywords: ['theme', 'colour', 'color', 'appearance'],
    icon,
    run: ({ close }) => {
      setThemePreference(value)
      close()
    },
  }))
}

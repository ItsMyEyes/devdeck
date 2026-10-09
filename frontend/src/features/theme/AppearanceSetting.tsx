import { Monitor, Moon, Sun } from 'lucide-react'
import { useThemePreference } from '@/features/theme/useTheme'

const options = [
  { value: 'light', label: 'Light', description: 'A bright workspace', icon: Sun },
  { value: 'dark', label: 'Dark', description: 'A dim workspace', icon: Moon },
  { value: 'system', label: 'System', description: 'Follow your device', icon: Monitor },
] as const

export function AppearanceSetting() {
  const [preference, setPreference] = useThemePreference()
  return (
    <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      <legend className="sr-only">Colour scheme</legend>
      {options.map(({ value, label, description, icon: Icon }) => (
        <label key={value} className="relative cursor-pointer">
          <input
            type="radio"
            name="appearance-theme"
            value={value}
            checked={preference === value}
            onChange={() => setPreference(value)}
            className="peer sr-only"
          />
          <div className="flex h-full items-center gap-2.5 rounded-control border border-devdeck-border-card bg-devdeck-card-wash p-2.5 transition-colors hover:bg-devdeck-hover-wash peer-checked:border-devdeck-accent peer-checked:bg-devdeck-accent-tint peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-devdeck-ring">
            <Icon size={16} className="flex-none text-devdeck-accent" />
            <div>
              <p className="text-[12px] text-devdeck-fg">{label}</p>
              <p className="text-[10.5px] text-devdeck-fg-2">{description}</p>
            </div>
          </div>
        </label>
      ))}
    </fieldset>
  )
}

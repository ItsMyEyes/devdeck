import { Moon } from 'lucide-react'

/**
 * Appearance setting: informational only.
 *
 * There used to be a Light / Dark / System picker here. Light mode is
 * disabled — DevDeck is dark-only — so there is nothing left to choose; this
 * just states the fact rather than offering a radiogroup with one option
 * that can never change.
 */
export function AppearanceSetting() {
  return (
    <div className="flex items-center gap-2.5 rounded-control border border-devdeck-border-card bg-devdeck-on p-2.5">
      <Moon size={13} className="flex-none text-devdeck-accent" />
      <div>
        <p className="text-[12px] text-devdeck-fg">Dark</p>
        <p className="font-mono text-[10.5px] text-devdeck-fg-2">Light mode is disabled — DevDeck is dark-only.</p>
      </div>
    </div>
  )
}

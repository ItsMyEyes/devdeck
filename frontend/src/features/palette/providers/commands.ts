import { Terminal } from 'lucide-react'
import { parseSSHCommand } from '@/features/ssh/sshCommand'
import type { PaletteItem } from '@/features/palette/paletteTypes'

export interface PaletteVerb {
  name: string
  aliases: string[]
  argHint: string
}

export const PALETTE_VERBS: PaletteVerb[] = [
  { name: 'ssh', aliases: [], argHint: '<ssh command | host>' },
  { name: 'agent-new', aliases: ['agents-new'], argHint: '<project>' },
  { name: 'browser', aliases: ['open'], argHint: '<url>' },
]

function findVerb(word: string): PaletteVerb | undefined {
  const lower = word.toLowerCase()
  return PALETTE_VERBS.find((v) => v.name === lower || v.aliases.includes(lower))
}

/**
 * Splits `query` into a verb and its argument.
 *
 * Returns `null` when there is no argument — a bare `ssh` must stay an
 * ordinary search term, because "SSH" is also a page name and hosts are
 * routinely named `ssh-*`. Only once the user types something after the verb
 * do we take over the input.
 */
export function matchVerb(query: string): { verb: PaletteVerb; arg: string } | null {
  const trimmed = query.trimStart()
  const space = trimmed.indexOf(' ')
  if (space === -1) return null

  const verb = findVerb(trimmed.slice(0, space))
  if (!verb) return null

  const arg = trimmed.slice(space + 1).trim()
  if (!arg) return null

  return { verb, arg }
}

/** Template rows shown while the user is still typing a verb's name, so the
 *  grammar is discoverable without documentation. */
export function verbHintItems(query: string): PaletteItem[] {
  const trimmed = query.trim()
  if (!trimmed || trimmed.includes(' ')) return []

  const lower = trimmed.toLowerCase()
  return PALETTE_VERBS.filter((verb) => verb.name.startsWith(lower) || verb.aliases.some((a) => a.startsWith(lower)))
    .map((verb) => ({
      id: `verb:${verb.name}`,
      kind: 'command' as const,
      group: 'results' as const,
      title: `${verb.name} ${verb.argHint}`,
      subtitle: 'command',
      icon: Terminal,
      completion: `${verb.name} `,
    }))
}

/** Human-readable echo of what `parseSSHCommand` understood, mirroring the
 *  preview line the SSH quick-add form already shows. */
export function sshCommandPreview(arg: string): { summary: string; ignored: string[] } | null {
  const parsed = parseSSHCommand(`ssh ${arg}`)
  if (!parsed) return null

  const target = `${parsed.target.user || '(no user)'}@${parsed.target.host}:${parsed.target.port}`
  const via = parsed.jumps.length > 0 ? ` · via ${parsed.jumps.map((h) => `${h.user}@${h.host}`).join(' → ')}` : ''

  return { summary: `${target}${via}`, ignored: parsed.ignoredFlags }
}

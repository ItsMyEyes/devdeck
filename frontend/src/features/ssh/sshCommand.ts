// Parses an ssh(1) command line into the fields an `SSHConnection` needs
// (design: docs/superpowers/specs/2026-07-30-ssh-new-tab-quick-add-design.md).
// Deliberately free of app imports so it can be unit-tested with `npx tsx`,
// like jumpHostDraft.ts next to it.

export interface ParsedSSHHop {
  /** May be empty — the backend requires a username, but an empty one here
   *  blocks submit rather than failing the parse, so a half-typed command
   *  still fills in the host. */
  user: string
  host: string
  port: number
}

export interface ParsedSSHCommand {
  target: ParsedSSHHop
  /** In `-J` order: nearest hop first, matching ssh(1)'s own semantics. */
  jumps: ParsedSSHHop[]
  /** `-i` path, passed through verbatim — it is resolved on the executor
   *  machine, not here, so `~` is deliberately left alone. */
  identityFile: string | null
  /** Recognised-but-unmapped flags, deduped, for the UI's "Ignored: …" note. */
  ignoredFlags: string[]
}

/** Short flags that take a value, whether or not this parser uses it. Listing
 *  the unused ones matters: without it, `-o StrictHostKeyChecking=no host`
 *  would treat `StrictHostKeyChecking=no` as the destination. */
const VALUE_FLAGS = new Set([
  'b', 'c', 'D', 'E', 'e', 'F', 'I', 'i', 'J', 'L', 'l', 'm', 'O', 'o', 'p', 'Q', 'R', 'S', 'W', 'w',
])

/** Whitespace split with single/double-quote grouping, so `-i "/a b/key"`
 *  survives. Escapes are not interpreted — paths, not shell scripts. */
function tokenize(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: string | null = null
  for (const ch of raw) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      started = true
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      if (started) {
        tokens.push(current)
        current = ''
        started = false
      }
      continue
    }
    current += ch
    started = true
  }
  if (started) tokens.push(current)
  return tokens
}

/** `[user@]host[:port]`. Port comes back null when unspecified so callers can
 *  layer their own default (`-p` for the target, 22 for a hop). */
function parseHop(spec: string): { user: string; host: string; port: number | null } | null {
  const trimmed = spec.trim()
  if (!trimmed) return null
  const at = trimmed.lastIndexOf('@')
  const user = at === -1 ? '' : trimmed.slice(0, at)
  let host = at === -1 ? trimmed : trimmed.slice(at + 1)
  if (!host) return null

  // Only a *single* colon means "host:port" — a multi-colon host is a bare
  // IPv6 literal and is taken verbatim.
  const colon = host.indexOf(':')
  let port: number | null = null
  if (colon !== -1 && host.lastIndexOf(':') === colon) {
    const digits = host.slice(colon + 1)
    const value = Number.parseInt(digits, 10)
    if (Number.isInteger(value) && String(value) === digits) {
      port = value
      host = host.slice(0, colon)
    }
  }
  if (!host) return null
  return { user, host, port }
}

export function parseSSHCommand(raw: string): ParsedSSHCommand | null {
  const tokens = tokenize(raw)
  if (tokens[0]?.toLowerCase() === 'ssh') tokens.shift()

  let destination: string | null = null
  let portFlag: number | null = null
  let userFlag = ''
  let identityFile: string | null = null
  const jumpSpecs: string[] = []
  const ignoredFlags: string[] = []

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token === '--') continue
    if (!token.startsWith('-')) {
      // The first bare token is the destination; a second one starts the
      // remote command, which is none of our business.
      if (destination !== null) break
      destination = token
      continue
    }
    if (token.startsWith('--')) {
      ignoredFlags.push(token)
      continue
    }

    const letter = token[1]
    if (letter === undefined) {
      // A bare "-" token (no flag letter at all) — record it verbatim rather
      // than interpolating `undefined` into the ignored-flag string below.
      ignoredFlags.push(token)
      continue
    }
    const attached = token.slice(2)
    let value = attached
    if (VALUE_FLAGS.has(letter) && !attached) {
      value = tokens[i + 1] ?? ''
      i += 1
    }

    switch (letter) {
      case 'p': {
        const port = Number.parseInt(value, 10)
        if (Number.isInteger(port)) portFlag = port
        break
      }
      case 'l':
        if (value) userFlag = value
        break
      case 'i':
        if (value) identityFile = value
        break
      case 'J':
        for (const spec of value.split(',')) {
          const trimmed = spec.trim()
          if (trimmed) jumpSpecs.push(trimmed)
        }
        break
      default:
        ignoredFlags.push(`-${letter}`)
    }
  }

  if (!destination) return null
  const parsedTarget = parseHop(destination)
  if (!parsedTarget) return null

  const targetUser = parsedTarget.user || userFlag
  const target: ParsedSSHHop = {
    user: targetUser,
    host: parsedTarget.host,
    // `-p` is the real ssh flag; `host:port` is only a convenience, so the
    // flag wins when both are present.
    port: portFlag ?? parsedTarget.port ?? 22,
  }

  const jumps: ParsedSSHHop[] = []
  for (const spec of jumpSpecs) {
    const hop = parseHop(spec)
    if (!hop) continue
    jumps.push({ user: hop.user || targetUser, host: hop.host, port: hop.port ?? 22 })
  }

  return { target, jumps, identityFile, ignoredFlags: Array.from(new Set(ignoredFlags)) }
}

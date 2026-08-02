/** The shell the one-liner will be pasted into. The operator picks this to
 *  match the target machine: the fetcher differs, and so do the quoting
 *  rules. See docs/superpowers/specs/2026-07-26-runtime-install-command-design.md. */
export type InstallTarget = 'curl' | 'wget' | 'powershell'

export interface InstallCommandInput {
  target: InstallTarget
  /** Resolved hub base URL — Tailscale's URL on a loopback hub, else window.location.origin. */
  hubUrl: string
  /** The hub's bearer key from GET /api/self/hub-key; '' renders a placeholder. */
  hubKey: string
  /** Display name for the machine; '' renders a placeholder. */
  machineName: string
}

/** Where deploy-docs.yml publishes the installer scripts. Matches scripts/README.md. */
const INSTALL_BASE_URL = 'https://kiyora.is-a.dev/devdeck'

/** Wraps a value in POSIX single quotes. An embedded single quote ends the
 *  quoted run, so it is closed, escaped, and reopened — the '\'' idiom. */
function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Wraps a value in PowerShell single quotes, where an embedded single quote
 *  is escaped by doubling it. */
function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, `''`)}'`
}

function orPlaceholder(value: string, placeholder: string): string {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : placeholder
}

/** Builds the one-line install command shown in the Add-runtime dialog.
 *  Missing values render as angle-bracket placeholders rather than producing
 *  a command that looks complete but silently misbehaves. */
export function buildInstallCommand(input: InstallCommandInput): string {
  const hubUrl = orPlaceholder(input.hubUrl, '<hub-url>')
  const hubKey = orPlaceholder(input.hubKey, '<your-hub-key>')
  const name = orPlaceholder(input.machineName, '<name>')

  if (input.target === 'powershell') {
    return [
      `$env:DEVDECK_HUB_URL=${powershellQuote(hubUrl)}`,
      `$env:DEVDECK_HUB_KEY=${powershellQuote(hubKey)}`,
      `$env:DEVDECK_MACHINE_NAME=${powershellQuote(name)}`,
      `irm ${INSTALL_BASE_URL}/install.ps1 | iex`,
    ].join('; ')
  }

  const fetcher =
    input.target === 'wget'
      ? `wget -qO- ${INSTALL_BASE_URL}/install.sh`
      : `curl -fsSL ${INSTALL_BASE_URL}/install.sh`

  return [
    `${fetcher} | \\`,
    `  DEVDECK_HUB_URL=${posixQuote(hubUrl)} \\`,
    `  DEVDECK_HUB_KEY=${posixQuote(hubKey)} \\`,
    `  DEVDECK_MACHINE_NAME=${posixQuote(name)} sh`,
  ].join('\n')
}

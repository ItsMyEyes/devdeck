# Security Policy

DevDeck is currently a private repository. If you have access to it and
discover a security vulnerability, please report it privately rather than
opening a public issue, pull request, or discussion.

## Reporting a Vulnerability

Report vulnerabilities through GitHub's private security advisory flow:

**https://github.com/ItsMyEyes/devdeck/security/advisories/new**

This opens a private channel with the maintainer — nothing is visible
publicly until a fix ships and the advisory is disclosed.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal repro is ideal)
- Affected component (backend, frontend, desktop/Tauri shell, MCP server,
  etc.) and, if known, the relevant file(s)
- Any relevant logs, stack traces, or proof-of-concept code

## Response

Reports are acknowledged and triaged as they come in. DevDeck is pre-1.0 and
under active development, so fixes ship as soon as they're ready rather than
on a fixed release cadence — there is no formal supported-version matrix yet.

## Scope notes

DevDeck is a local-first, single-operator tool that also supports
multi-machine deployments over Tailscale (hub + runtime roles). Reports are
especially welcome in these areas:

- Authentication and session handling (login, 2FA/TOTP, backup codes,
  cookies)
- Hub/runtime machine registration and key-based machine-to-machine auth
- Terminal/PTY sessions and SSH file transfer handling
- Secrets and credential storage (env profiles, SSH credentials, signing
  keys, database connection secrets)

Out of scope: vulnerabilities that require an attacker to already have
filesystem or shell access to a machine running DevDeck — the threat model
assumes the operator's own machines are trusted.

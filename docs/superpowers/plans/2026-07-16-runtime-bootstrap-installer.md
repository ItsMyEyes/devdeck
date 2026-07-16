# Runtime Bootstrap Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the already-existing runtime binary with a checklist installer so adding a new runtime machine becomes: copy one folder, fill in `runtime.env` once, run one command.

**Architecture:** A new top-level `installer/` directory holds `install.sh`/`uninstall.sh` (macOS/Linux) and `install.ps1`/`uninstall.ps1` (Windows), plus a `runtime.env.example` template and a `README.md`. A new Makefile target (`runtime-bundle-all`) assembles, per OS/arch, an archive containing the portable binary (already built by the existing `portable-all` target) plus these installer files. CI uploads those archives as release assets alongside the existing binaries. No backend Go code is touched by this plan — see `docs/superpowers/plans/2026-07-16-hub-paste-connect.md` for the backend/frontend half of the spec (the `/api/whoami` route and paste-connection-string UI this installer's `copy-this.md` output is meant to be pasted into).

**Tech Stack:** Bash (macOS/Linux installer), PowerShell (Windows installer), GNU Make, GitHub Actions.

## Global Constraints

- `runtime.env` (with real secrets) must never be committed — only `runtime.env.example` is a tracked file. The `.gitignore` must cover any local test fixtures created while exercising these scripts.
- Bash scripts start with `set -euo pipefail` and must not assume `jq`, `python`, or any tool beyond what a stock macOS/Linux install ships (`curl`, `grep`, `sed`, `openssl`, `uname`) — no new dependency beyond what's explicitly installed by the checklist itself (Tailscale).
- PowerShell scripts start with `$ErrorActionPreference = "Stop"` and must not assume any module beyond what ships with Windows PowerShell 5.1+ / PowerShell 7 (`ScheduledTasks` is built in).
- Every script accepts `--dry-run` (bash) / `-DryRun` (PowerShell) and must perform zero mutating actions in that mode.
- Makefile targets follow the existing style in `Makefile` (see `portable-all`): `.PHONY`, `$(DIST_DIR)` for output, one target per concern.
- This plan does not modify `backend/cmd/server/main.go`, any Go file, or any frontend file — it is purely new shell/PowerShell/Makefile/CI files.

---

### Task 1: `install.sh` / `uninstall.sh` (macOS/Linux)

**Files:**
- Create: `installer/install.sh`
- Create: `installer/uninstall.sh`

**Interfaces:**
- Consumes: `installer/runtime.env.example`'s variable names (`TS_AUTHKEY`, `LOOM_HUB_URL`, `LOOM_HUB_KEY`, `LOOM_MACHINE_NAME`, `LOOM_ADDR`) — Task 3 creates that file; this task can be written and tested against a hand-made fixture `runtime.env` first, then Task 3's template is just the redistributable version of the same shape.
- Produces: `installer/runtime.key` (generated at first run, gitignored), `installer/copy-this.md` (generated at every run), a `launchd` LaunchAgent (macOS) or `systemd --user` unit (Linux) named for the `dev.loom.runtime` label / `loom-runtime.service` unit — Task 4 bundles these two scripts as-is, unchanged.

- [ ] **Step 1: Write `install.sh`**

Create `installer/install.sh`:

```bash
#!/usr/bin/env bash
# install.sh — checklist installer for a Loom runtime machine (macOS/Linux).
# Copy this whole bundle folder (this script + the `loom` binary +
# runtime.env) to a new machine, fill in runtime.env once, then run this.
# See docs/superpowers/specs/2026-07-16-runtime-bootstrap-installer-design.md.
set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) echo "unknown argument: $arg" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/runtime.env"
KEY_FILE="$SCRIPT_DIR/runtime.key"
COPY_FILE="$SCRIPT_DIR/copy-this.md"
BINARY="$SCRIPT_DIR/loom"

run() {
  if $DRY_RUN; then
    echo "  [dry-run] would run: $*"
  else
    "$@"
  fi
}

echo "==> Preflight"
if [ ! -f "$ENV_FILE" ]; then
  echo "error: $ENV_FILE not found — copy runtime.env.example to runtime.env and fill it in" >&2
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

if [ -z "${TS_AUTHKEY:-}" ] || [ "$TS_AUTHKEY" = "<reusable Tailscale auth key from the admin console>" ]; then
  echo "error: TS_AUTHKEY is missing or still the placeholder value in $ENV_FILE" >&2
  exit 1
fi
if [ -n "${LOOM_HUB_URL:-}" ] && [ -z "${LOOM_HUB_KEY:-}" ]; then
  echo "error: LOOM_HUB_URL is set but LOOM_HUB_KEY is empty in $ENV_FILE — set both or neither" >&2
  exit 1
fi
if [ -z "${LOOM_HUB_URL:-}" ] && [ -n "${LOOM_HUB_KEY:-}" ]; then
  echo "error: LOOM_HUB_KEY is set but LOOM_HUB_URL is empty in $ENV_FILE — set both or neither" >&2
  exit 1
fi
MACHINE_NAME="${LOOM_MACHINE_NAME:-$(hostname -s)}"
echo "  ok, using name '$MACHINE_NAME'"

echo "==> Tailscale checklist"
if ! command -v tailscale >/dev/null 2>&1; then
  echo "  tailscale not found, installing..."
  if [ "$(uname -s)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    run brew install tailscale
  else
    run bash -c "curl -fsSL https://tailscale.com/install.sh | sh"
  fi
else
  echo "  \xE2\x9C\x93 tailscale already installed"
fi

if $DRY_RUN; then
  echo "  [dry-run] would check 'tailscale status' and run 'tailscale up --authkey=*** --hostname=$MACHINE_NAME --ssh=false' if not already joined"
  DNSNAME="$MACHINE_NAME.example.ts.net"
else
  if ! tailscale status >/dev/null 2>&1; then
    echo "  joining tailnet..."
    tailscale up --authkey="$TS_AUTHKEY" --hostname="$MACHINE_NAME" --ssh=false
  else
    echo "  \xE2\x9C\x93 already joined tailnet"
  fi
  DNSNAME=$(tailscale status --self --json | grep -o '"DNSName":"[^"]*"' | head -1 | sed 's/"DNSName":"//;s/"$//')
  DNSNAME="${DNSNAME%.}"
  if [ -z "$DNSNAME" ]; then
    echo "error: could not read this machine's MagicDNS name from 'tailscale status --self --json'" >&2
    exit 1
  fi
fi
PUBLIC_URL="https://$DNSNAME"
echo "  \xE2\x9C\x93 joined tailnet as $DNSNAME"

echo "==> Runtime key"
if [ -f "$KEY_FILE" ]; then
  LOOM_KEY="$(cat "$KEY_FILE")"
  echo "  \xE2\x9C\x93 reusing existing key from $KEY_FILE"
else
  LOOM_KEY="$(openssl rand -hex 32)"
  if ! $DRY_RUN; then
    printf '%s' "$LOOM_KEY" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
  fi
  echo "  \xE2\x9C\x93 generated a new runtime key"
fi

echo "==> Background service"
UNAME_S="$(uname -s)"
if [ "$UNAME_S" = "Darwin" ]; then
  LABEL="dev.loom.runtime"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    echo "  found an existing installation, stopping it before re-registering"
    run launchctl bootout "gui/$(id -u)/$LABEL"
  fi
  ENV_XML=""
  for var in LOOM_ROLE LOOM_KEY LOOM_HUB_URL LOOM_HUB_KEY LOOM_PUBLIC_URL LOOM_MACHINE_NAME LOOM_TAILSCALE_SERVE; do
    val=""
    case "$var" in
      LOOM_ROLE) val="runtime" ;;
      LOOM_KEY) val="$LOOM_KEY" ;;
      LOOM_HUB_URL) val="${LOOM_HUB_URL:-}" ;;
      LOOM_HUB_KEY) val="${LOOM_HUB_KEY:-}" ;;
      LOOM_PUBLIC_URL) val="$PUBLIC_URL" ;;
      LOOM_MACHINE_NAME) val="$MACHINE_NAME" ;;
      LOOM_TAILSCALE_SERVE) val="true" ;;
    esac
    ENV_XML="$ENV_XML    <key>$var</key><string>$val</string>
"
  done
  PLIST_CONTENT="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BINARY</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$SCRIPT_DIR/runtime.log</string>
  <key>StandardErrorPath</key><string>$SCRIPT_DIR/runtime.log</string>
  <key>EnvironmentVariables</key>
  <dict>
$ENV_XML  </dict>
</dict>
</plist>"
  if $DRY_RUN; then
    echo "  [dry-run] would write $PLIST and run 'launchctl bootstrap gui/$(id -u) $PLIST'"
  else
    printf '%s\n' "$PLIST_CONTENT" > "$PLIST"
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
  fi
  echo "  \xE2\x9C\x93 registered as a launchd LaunchAgent ($PLIST)"
else
  UNIT_DIR="$HOME/.config/systemd/user"
  UNIT="$UNIT_DIR/loom-runtime.service"
  MERGED_ENV="$SCRIPT_DIR/runtime.merged.env"
  if systemctl --user is-active --quiet loom-runtime.service 2>/dev/null; then
    echo "  found an existing installation, stopping it before re-registering"
    run systemctl --user stop loom-runtime.service
  fi
  {
    echo "LOOM_ROLE=runtime"
    echo "LOOM_KEY=$LOOM_KEY"
    echo "LOOM_PUBLIC_URL=$PUBLIC_URL"
    echo "LOOM_MACHINE_NAME=$MACHINE_NAME"
    echo "LOOM_TAILSCALE_SERVE=true"
    [ -n "${LOOM_HUB_URL:-}" ] && echo "LOOM_HUB_URL=$LOOM_HUB_URL"
    [ -n "${LOOM_HUB_KEY:-}" ] && echo "LOOM_HUB_KEY=$LOOM_HUB_KEY"
  } > "$MERGED_ENV"
  chmod 600 "$MERGED_ENV"
  UNIT_CONTENT="[Unit]
Description=Loom runtime

[Service]
ExecStart=$BINARY
EnvironmentFile=$MERGED_ENV
Restart=on-failure

[Install]
WantedBy=default.target"
  if $DRY_RUN; then
    echo "  [dry-run] would write $UNIT and run 'systemctl --user enable --now loom-runtime.service'"
  else
    mkdir -p "$UNIT_DIR"
    printf '%s\n' "$UNIT_CONTENT" > "$UNIT"
    systemctl --user daemon-reload
    systemctl --user enable --now loom-runtime.service
  fi
  echo "  \xE2\x9C\x93 registered as a systemd --user service ($UNIT)"
fi

echo "==> Connection string"
CONN_STRING="$MACHINE_NAME|$PUBLIC_URL|$LOOM_KEY"
COPY_CONTENT="# Connect this runtime to your hub

Paste the line below into the hub's **Add Runtime** dialog ->
**Paste connection string**:

    $CONN_STRING
"
if $DRY_RUN; then
  echo "  [dry-run] would write $COPY_FILE with:"
  echo "    $CONN_STRING"
else
  printf '%s\n' "$COPY_CONTENT" > "$COPY_FILE"
fi
echo "  \xE2\x9C\x93 wrote $COPY_FILE"

echo ""
echo "==> Done"
echo "  machine:   $MACHINE_NAME"
echo "  URL:       $PUBLIC_URL"
if [ -n "${LOOM_HUB_URL:-}" ]; then
  echo "  self-registration is configured — it should appear on the hub's Machines page shortly."
else
  echo "  paste the contents of $COPY_FILE into the hub's Add Runtime dialog to connect it."
fi
```

- [ ] **Step 2: Write `uninstall.sh`**

Create `installer/uninstall.sh`:

```bash
#!/usr/bin/env bash
# uninstall.sh — removes the background service registered by install.sh.
# Does not touch Tailscale's join state or the hub's machine registry.
set -euo pipefail

if [ "$(uname -s)" = "Darwin" ]; then
  LABEL="dev.loom.runtime"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/$LABEL"
    echo "stopped and unloaded $LABEL"
  else
    echo "no running $LABEL service found"
  fi
  rm -f "$PLIST"
  echo "removed $PLIST"
else
  if systemctl --user is-enabled --quiet loom-runtime.service 2>/dev/null; then
    systemctl --user disable --now loom-runtime.service
    echo "stopped and disabled loom-runtime.service"
  else
    echo "no loom-runtime.service found"
  fi
  rm -f "$HOME/.config/systemd/user/loom-runtime.service"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "removed the unit file"
fi
```

- [ ] **Step 3: Make both scripts executable**

Run: `chmod +x installer/install.sh installer/uninstall.sh`

- [ ] **Step 4: Lint (best-effort) and dry-run against a fixture env**

If `shellcheck` is available (`command -v shellcheck`), run it — fix any warnings it raises; it's advisory here, not a hard gate, since it isn't part of this repo's existing toolchain.

Run: `cd installer && shellcheck install.sh uninstall.sh || true`

Create a throwaway fixture and dry-run the installer against it (this does not touch your real Tailscale/service state):

```bash
cd installer
cp runtime.env.example runtime.env 2>/dev/null || cat > runtime.env <<'EOF'
TS_AUTHKEY=tskey-test-fixture-value
EOF
./install.sh --dry-run
rm -f runtime.env
```

Expected output includes, in order: `==> Preflight` / `ok, using name '<your hostname>'`, `==> Tailscale checklist` (either "already installed" or a dry-run install line), a dry-run tailscale-up line, `==> Runtime key` / `generated a new runtime key` (no `runtime.key` exists yet in a fresh checkout), `==> Background service` / a dry-run plist-or-unit line, `==> Connection string` / a dry-run line showing `<hostname>|https://<hostname>.example.ts.net|<64-hex-chars>`, ending with `==> Done`. Confirm no `runtime.key`, `copy-this.md`, plist, or systemd unit file was actually created (`ls installer/`, `launchctl list | grep loom` / `systemctl --user status loom-runtime` should show nothing).

- [ ] **Step 5: Commit**

```bash
git add installer/install.sh installer/uninstall.sh
git commit -m "feat(installer): add macOS/Linux runtime bootstrap install/uninstall scripts"
```

---

### Task 2: `install.ps1` / `uninstall.ps1` (Windows)

**Files:**
- Create: `installer/install.ps1`
- Create: `installer/uninstall.ps1`

**Interfaces:**
- Consumes: same `runtime.env` variable names as Task 1.
- Produces: `installer/runtime.key`, `installer/copy-this.md`, `installer/run-runtime.bat` (a generated wrapper that sets env vars then execs `loom.exe`, since Scheduled Task actions can't set env vars directly), and a Scheduled Task named `LoomRuntime` registered to run `run-runtime.bat` at logon.

- [ ] **Step 1: Write `install.ps1`**

Create `installer/install.ps1`:

```powershell
<#
  install.ps1 — checklist installer for a Loom runtime machine (Windows).
  Copy this whole bundle folder (this script + loom.exe + runtime.env) to a
  new machine, fill in runtime.env once, then run this. See
  docs/superpowers/specs/2026-07-16-runtime-bootstrap-installer-design.md.
#>
param(
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile = Join-Path $ScriptDir "runtime.env"
$KeyFile = Join-Path $ScriptDir "runtime.key"
$CopyFile = Join-Path $ScriptDir "copy-this.md"
$Binary = Join-Path $ScriptDir "loom.exe"
$RunBat = Join-Path $ScriptDir "run-runtime.bat"
$TaskName = "LoomRuntime"

Write-Host "==> Preflight"
if (-not (Test-Path $EnvFile)) {
    Write-Error "$EnvFile not found -- copy runtime.env.example to runtime.env and fill it in"
    exit 1
}

$EnvVars = @{}
Get-Content $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq "" -or $line.StartsWith("#")) { return }
    $parts = $line.Split("=", 2)
    if ($parts.Length -eq 2) { $EnvVars[$parts[0].Trim()] = $parts[1].Trim() }
}

$TsAuthKey = $EnvVars["TS_AUTHKEY"]
if ([string]::IsNullOrEmpty($TsAuthKey) -or $TsAuthKey -eq "<reusable Tailscale auth key from the admin console>") {
    Write-Error "TS_AUTHKEY is missing or still the placeholder value in $EnvFile"
    exit 1
}
$HubUrl = $EnvVars["LOOM_HUB_URL"]
$HubKey = $EnvVars["LOOM_HUB_KEY"]
if (($HubUrl -and -not $HubKey) -or ($HubKey -and -not $HubUrl)) {
    Write-Error "LOOM_HUB_URL and LOOM_HUB_KEY must both be set, or both be empty, in $EnvFile"
    exit 1
}
$MachineName = $EnvVars["LOOM_MACHINE_NAME"]
if ([string]::IsNullOrEmpty($MachineName)) { $MachineName = $env:COMPUTERNAME }
Write-Host "  ok, using name '$MachineName'"

Write-Host "==> Tailscale checklist"
$tailscale = Get-Command tailscale -ErrorAction SilentlyContinue
if (-not $tailscale) {
    Write-Host "  tailscale not found, installing via winget..."
    if ($DryRun) {
        Write-Host "  [dry-run] would run: winget install Tailscale.Tailscale -e --silent"
    } else {
        winget install Tailscale.Tailscale -e --silent
    }
} else {
    Write-Host "  ok tailscale already installed"
}

if ($DryRun) {
    Write-Host "  [dry-run] would check 'tailscale status' and run 'tailscale up --authkey=*** --hostname=$MachineName --ssh=false' if not already joined"
    $DnsName = "$MachineName.example.ts.net"
} else {
    tailscale status *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  joining tailnet..."
        tailscale up --authkey=$TsAuthKey --hostname=$MachineName --ssh=false
    } else {
        Write-Host "  ok already joined tailnet"
    }
    $StatusJson = tailscale status --self --json | ConvertFrom-Json
    $DnsName = $StatusJson.Self.DNSName.TrimEnd(".")
    if ([string]::IsNullOrEmpty($DnsName)) {
        Write-Error "could not read this machine's MagicDNS name from 'tailscale status --self --json'"
        exit 1
    }
}
$PublicUrl = "https://$DnsName"
Write-Host "  ok joined tailnet as $DnsName"

Write-Host "==> Runtime key"
if (Test-Path $KeyFile) {
    $LoomKey = (Get-Content $KeyFile -Raw).Trim()
    Write-Host "  ok reusing existing key from $KeyFile"
} else {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    $LoomKey = -join ($bytes | ForEach-Object { $_.ToString("x2") })
    if (-not $DryRun) { Set-Content -Path $KeyFile -Value $LoomKey -NoNewline }
    Write-Host "  ok generated a new runtime key"
}

Write-Host "==> Background service"
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "  found an existing installation, stopping it before re-registering"
    if (-not $DryRun) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
}

$batLines = @(
    "@echo off",
    "set LOOM_ROLE=runtime",
    "set LOOM_KEY=$LoomKey",
    "set LOOM_PUBLIC_URL=$PublicUrl",
    "set LOOM_MACHINE_NAME=$MachineName",
    "set LOOM_TAILSCALE_SERVE=true"
)
if ($HubUrl) { $batLines += "set LOOM_HUB_URL=$HubUrl" }
if ($HubKey) { $batLines += "set LOOM_HUB_KEY=$HubKey" }
$batLines += "`"$Binary`""

if ($DryRun) {
    Write-Host "  [dry-run] would write $RunBat and register a Scheduled Task '$TaskName' at logon"
} else {
    Set-Content -Path $RunBat -Value $batLines
    $action = New-ScheduledTaskAction -Execute $RunBat
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
}
Write-Host "  ok registered as a Scheduled Task at logon ($TaskName)"

Write-Host "==> Connection string"
$ConnString = "$MachineName|$PublicUrl|$LoomKey"
$CopyContent = @"
# Connect this runtime to your hub

Paste the line below into the hub's **Add Runtime** dialog ->
**Paste connection string**:

    $ConnString
"@
if ($DryRun) {
    Write-Host "  [dry-run] would write $CopyFile with:"
    Write-Host "    $ConnString"
} else {
    Set-Content -Path $CopyFile -Value $CopyContent
}
Write-Host "  ok wrote $CopyFile"

Write-Host ""
Write-Host "==> Done"
Write-Host "  machine:   $MachineName"
Write-Host "  URL:       $PublicUrl"
if ($HubUrl) {
    Write-Host "  self-registration is configured -- it should appear on the hub's Machines page shortly."
} else {
    Write-Host "  paste the contents of $CopyFile into the hub's Add Runtime dialog to connect it."
}
```

- [ ] **Step 2: Write `uninstall.ps1`**

Create `installer/uninstall.ps1`:

```powershell
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TaskName = "LoomRuntime"

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "removed Scheduled Task $TaskName"
} else {
    Write-Host "no Scheduled Task named $TaskName found"
}
$runBat = Join-Path $ScriptDir "run-runtime.bat"
if (Test-Path $runBat) {
    Remove-Item -Path $runBat
    Write-Host "removed run-runtime.bat"
}
```

- [ ] **Step 3: Lint (best-effort) and dry-run against a fixture env**

If `PSScriptAnalyzer` is installed (`Get-Module -ListAvailable PSScriptAnalyzer`), run it — advisory only, matching Task 1's `shellcheck` treatment:

Run: `Invoke-ScriptAnalyzer -Path installer\install.ps1, installer\uninstall.ps1`

Create a throwaway fixture and dry-run (on a Windows machine or CI runner — this repo's own CI already runs a Windows matrix leg for the desktop build, see Task 4):

```powershell
cd installer
Set-Content -Path runtime.env -Value "TS_AUTHKEY=tskey-test-fixture-value"
.\install.ps1 -DryRun
Remove-Item runtime.env
```

Expected: the same step-by-step `==>` sections as Task 1's bash dry-run, ending in `==> Done`, with no `runtime.key`, `copy-this.md`, `run-runtime.bat`, or Scheduled Task actually created (`Get-ScheduledTask -TaskName LoomRuntime -ErrorAction SilentlyContinue` returns nothing).

- [ ] **Step 4: Commit**

```bash
git add installer/install.ps1 installer/uninstall.ps1
git commit -m "feat(installer): add Windows runtime bootstrap install/uninstall scripts"
```

---

### Task 3: `runtime.env.example` and `README.md`

**Files:**
- Create: `installer/runtime.env.example`
- Create: `installer/README.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: the exact variable names Tasks 1-2 already read (`TS_AUTHKEY`, `LOOM_HUB_URL`, `LOOM_HUB_KEY`, `LOOM_MACHINE_NAME`); Task 4 bundles this file verbatim.

- [ ] **Step 1: Create `runtime.env.example`**

```
TS_AUTHKEY=<reusable Tailscale auth key from the admin console>
# LOOM_MACHINE_NAME=   (optional; defaults to OS hostname)

# Optional: enables automatic self-registration on startup. Leave both
# blank to skip self-registration and connect this machine manually
# instead, by pasting copy-this.md's contents into the hub's Add Runtime
# dialog once the installer finishes.
# LOOM_HUB_URL=
# LOOM_HUB_KEY=
```

- [ ] **Step 2: Create `README.md`**

```markdown
# Loom runtime bundle

This folder is everything you need to add this machine as a Loom runtime.

## One-time setup (do this once, per bundle download)

1. Copy `runtime.env.example` to `runtime.env`.
2. Generate a reusable Tailscale auth key from your Tailscale admin
   console's Keys page, and paste it in as `TS_AUTHKEY`.
3. (Optional) If you want this runtime to self-register with your hub
   automatically, fill in `LOOM_HUB_URL` and `LOOM_HUB_KEY` too. Leave both
   blank to skip this — you'll connect it manually instead (step 3 below).

## Adding a new machine (repeat this for every machine)

1. Copy this whole folder to the new machine (AirDrop, scp, USB — anything).
2. Run the installer:
   - macOS / Linux: `./install.sh`
   - Windows (PowerShell): `.\install.ps1`
3. If you didn't set `LOOM_HUB_URL`/`LOOM_HUB_KEY`, open `copy-this.md` and
   paste its one line into the hub's **Add Runtime** dialog -> **Paste
   connection string**.

Run the installer again any time (e.g. after editing `runtime.env`) to
update an existing installation in place — it's safe to re-run.

## Removing this runtime

- macOS / Linux: `./uninstall.sh`
- Windows: `.\uninstall.ps1`

This stops and removes the background service only. It does not remove the
machine from the hub's registry or leave the Tailscale network — do those
from the hub's Machines page / the Tailscale admin console.
```

- [ ] **Step 3: Gitignore the files these scripts generate locally**

Append to `.gitignore`:

```
# Runtime installer artifacts generated by installer/install.sh|.ps1 —
# secrets and machine-specific state, never committed.
installer/runtime.env
installer/runtime.key
installer/runtime.merged.env
installer/copy-this.md
installer/run-runtime.bat
installer/runtime.log
```

- [ ] **Step 4: Commit**

```bash
git add installer/runtime.env.example installer/README.md .gitignore
git commit -m "docs(installer): add runtime.env template and bundle README"
```

---

### Task 4: `make runtime-bundle-all`

**Files:**
- Modify: `Makefile`

**Interfaces:**
- Consumes: `installer/install.sh`, `installer/uninstall.sh`, `installer/install.ps1`, `installer/uninstall.ps1`, `installer/runtime.env.example`, `installer/README.md` (Tasks 1-3); the existing `portable-all` target's output naming convention `$(DIST_DIR)/loom-$(GOOS)-$(GOARCH)$(WINDOWS_EXT)`.
- Produces: `dist/bundles/loom-runtime-<os>-<arch>.tar.gz` (macOS/Linux) and `dist/bundles/loom-runtime-windows-<arch>.zip` (Windows) — Task 5 (CI) uploads these as release assets.

- [ ] **Step 1: Add the target**

In `Makefile`, add `runtime-bundle-all` to the `.PHONY` line (first line of the file):

Change:
```makefile
.PHONY: dev dev-web dev-api dev-hub dev-runtime free-ports seed-clean build build-web prepare-webui build-api build-mcp portable portable-current portable-all typecheck lint vet test install clean tag prepare-sidecar sidecar-host dev-tauri
```
to:
```makefile
.PHONY: dev dev-web dev-api dev-hub dev-runtime free-ports seed-clean build build-web prepare-webui build-api build-mcp portable portable-current portable-all runtime-bundle-all typecheck lint vet test install clean tag prepare-sidecar sidecar-host dev-tauri
```

Then add this block right after the existing `portable-all` target (after its last `windows-arm64` line):

```makefile

# Runtime bootstrap bundles: one archive per OS/arch containing the
# portable binary + install/uninstall scripts + env template + README, so
# an operator can copy one folder to a new machine and run one command
# (see docs/superpowers/specs/2026-07-16-runtime-bootstrap-installer-design.md).
BUNDLE_DIR := $(DIST_DIR)/bundles
INSTALLER_DIR := installer

runtime-bundle-all: portable-all
	mkdir -p $(BUNDLE_DIR)
	$(MAKE) _runtime-bundle-unix GOOS=darwin GOARCH=amd64
	$(MAKE) _runtime-bundle-unix GOOS=darwin GOARCH=arm64
	$(MAKE) _runtime-bundle-unix GOOS=linux GOARCH=amd64
	$(MAKE) _runtime-bundle-unix GOOS=linux GOARCH=arm64
	$(MAKE) _runtime-bundle-windows GOARCH=amd64
	$(MAKE) _runtime-bundle-windows GOARCH=arm64

_runtime-bundle-unix:
	rm -rf $(DIST_DIR)/stage
	mkdir -p $(DIST_DIR)/stage
	cp $(DIST_DIR)/loom-$(GOOS)-$(GOARCH) $(DIST_DIR)/stage/loom
	chmod +x $(DIST_DIR)/stage/loom
	cp $(INSTALLER_DIR)/install.sh $(INSTALLER_DIR)/uninstall.sh $(INSTALLER_DIR)/runtime.env.example $(INSTALLER_DIR)/README.md $(DIST_DIR)/stage/
	chmod +x $(DIST_DIR)/stage/install.sh $(DIST_DIR)/stage/uninstall.sh
	tar -C $(DIST_DIR)/stage -czf $(BUNDLE_DIR)/loom-runtime-$(GOOS)-$(GOARCH).tar.gz .
	rm -rf $(DIST_DIR)/stage

_runtime-bundle-windows:
	rm -rf $(DIST_DIR)/stage
	mkdir -p $(DIST_DIR)/stage
	cp $(DIST_DIR)/loom-windows-$(GOARCH).exe $(DIST_DIR)/stage/loom.exe
	cp $(INSTALLER_DIR)/install.ps1 $(INSTALLER_DIR)/uninstall.ps1 $(INSTALLER_DIR)/runtime.env.example $(INSTALLER_DIR)/README.md $(DIST_DIR)/stage/
	cd $(DIST_DIR)/stage && zip -qr ../bundles/loom-runtime-windows-$(GOARCH).zip .
	rm -rf $(DIST_DIR)/stage
```

Also add `.PHONY` entries for the two helper targets — change the line you just edited again to also include `_runtime-bundle-unix _runtime-bundle-windows`.

- [ ] **Step 2: Run it and verify the archive contents**

Run: `make runtime-bundle-all`
Expected: exits 0, and `ls dist/bundles/` shows all six files: `loom-runtime-darwin-amd64.tar.gz`, `loom-runtime-darwin-arm64.tar.gz`, `loom-runtime-linux-amd64.tar.gz`, `loom-runtime-linux-arm64.tar.gz`, `loom-runtime-windows-amd64.zip`, `loom-runtime-windows-arm64.zip`.

Verify one unix bundle's contents:
Run: `tar -tzf dist/bundles/loom-runtime-linux-amd64.tar.gz`
Expected: `./loom`, `./install.sh`, `./uninstall.sh`, `./runtime.env.example`, `./README.md` (five entries, `loom` executable via `tar -tvzf` showing `-rwxr-xr-x` on `./loom`, `./install.sh`, `./uninstall.sh`)

Verify the windows bundle's contents:
Run: `unzip -l dist/bundles/loom-runtime-windows-amd64.zip`
Expected: `loom.exe`, `install.ps1`, `uninstall.ps1`, `runtime.env.example`, `README.md`

- [ ] **Step 3: Update `clean` to remove the bundle output too**

In `Makefile`, change:
```makefile
clean:
	rm -f backend/loom-api
	rm -rf frontend/dist
	find $(WEBUI_DIR) -mindepth 1 ! -name .placeholder -exec rm -rf {} +
	rm -rf $(DIST_DIR)
```
This already removes `$(DIST_DIR)` wholesale (which includes `dist/bundles/`), so no change is actually needed here — run `make clean && ls dist 2>/dev/null; echo done` and confirm `dist/` no longer exists.

- [ ] **Step 4: Commit**

```bash
git add Makefile
git commit -m "feat(build): add make runtime-bundle-all to package runtime install bundles"
```

---

### Task 5: CI — publish bundles as release assets

**Files:**
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes: `make runtime-bundle-all` (Task 4).
- Produces: nothing further downstream — this is the last task in this plan.

- [ ] **Step 1: Add a bundling step and artifact upload to `build-backend`**

In `.github/workflows/release.yml`, change:

```yaml
      - name: Build portable binaries (hub + runtime)
        run: make portable-all

      - uses: actions/upload-artifact@v4
        with:
          name: backend-binaries
          path: dist/loom-*
          if-no-files-found: error
```

to:

```yaml
      - name: Build portable binaries (hub + runtime)
        run: make portable-all

      - uses: actions/upload-artifact@v4
        with:
          name: backend-binaries
          path: dist/loom-*
          if-no-files-found: error

      - name: Build runtime bootstrap bundles
        run: make runtime-bundle-all

      - uses: actions/upload-artifact@v4
        with:
          name: runtime-bundles
          path: dist/bundles/*
          if-no-files-found: error
```

- [ ] **Step 2: Include the bundles in the GitHub release**

In `.github/workflows/release.yml`, change:

```yaml
      - name: Create GitHub release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            artifacts/backend-binaries/*
            artifacts/desktop-macos/*
            artifacts/desktop-linux/*
            artifacts/desktop-windows/*
```

to:

```yaml
      - name: Create GitHub release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            artifacts/backend-binaries/*
            artifacts/runtime-bundles/*
            artifacts/desktop-macos/*
            artifacts/desktop-linux/*
            artifacts/desktop-windows/*
```

- [ ] **Step 3: Validate the workflow YAML**

Run: `cd /path/to/repo && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml'))" && echo "valid YAML"`
(or any YAML linter available locally — this just confirms the edits didn't break indentation)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: publish runtime bootstrap bundles as release assets"
```

The next tagged release (`make tag VERSION=vX.Y.Z`) will now attach six `loom-runtime-*` archives alongside the existing binaries and desktop installers — verify this the first time by checking the release's Assets list on GitHub after the workflow completes.

---

## Self-Review Notes

- **Spec coverage:** Decision 1 (platforms) → Tasks 1-2 cover macOS/Linux/Windows. Decision 2 (reusable authkey) → Task 1/2 Step 1 (`TS_AUTHKEY`, `tailscale up --authkey=`). Decision 3 (auto-install deps) → Tailscale checklist section in both installers. Decision 4 (bundle distribution, not curl|sh) → Task 4's archives. Decision 5 (background service) → launchd/systemd/Scheduled Task sections. Decision 6 (unique key per machine) → the `runtime.key` persistence logic. Decision 7 (no port in public URL) → `PUBLIC_URL="https://$DNSNAME"` / `$PublicUrl = "https://$DnsName"` with no port suffix in both installers. Decision 11 (already-running detection) → the "found an existing installation" branches in both installers' service-registration steps. The `--dry-run` mode and `uninstall` scripts are covered by Tasks 1-2 directly.
- **Placeholder scan:** no TBD/TODO; every script is complete, not sketched.
- **Type/interface consistency:** both installers read the exact same `runtime.env` variable names (`TS_AUTHKEY`, `LOOM_HUB_URL`, `LOOM_HUB_KEY`, `LOOM_MACHINE_NAME`) and write the exact same `name|url|key` format to `copy-this.md`, matching `parseConnectionString`'s expected input in the companion `2026-07-16-hub-paste-connect.md` plan. The Makefile's `_runtime-bundle-unix`/`_runtime-bundle-windows` helper targets reference exactly the filenames Tasks 1-3 created (`install.sh`, `uninstall.sh`, `install.ps1`, `uninstall.ps1`, `runtime.env.example`, `README.md`) and exactly the filenames `portable-all` already produces (`loom-$(GOOS)-$(GOARCH)$(WINDOWS_EXT)`).
- **Scope note:** this plan is deliberately split from `2026-07-16-hub-paste-connect.md` — it produces working software on its own (an operator can already bootstrap a runtime via self-registration today; this plan doesn't require the paste-connect plan to be implemented first), but the two are most useful together, so implement `hub-paste-connect` first if starting from scratch.

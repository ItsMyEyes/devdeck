#Requires -Version 5.1
<#
.SYNOPSIS
    DevDeck one-line installer for Windows.

.DESCRIPTION
    $env:GITHUB_TOKEN = 'ghp_xxx'
    irm https://kiyora.is-a.dev/devdeck/install.ps1 | iex

    Downloads the release binary for this platform, installs it under
    %LOCALAPPDATA%\DevDeck\bin, and - when DEVDECK_HUB_URL and
    DEVDECK_HUB_KEY are set - registers this machine as a runtime.

    Design: docs/superpowers/specs/2026-07-26-install-scripts-design.md
    Targets Windows PowerShell 5.1, so no PS7-only syntax.
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Owner = if ($env:DEVDECK_REPO_OWNER) { $env:DEVDECK_REPO_OWNER } else { 'ItsMyEyes' }
$script:Repo = if ($env:DEVDECK_REPO_NAME) { $env:DEVDECK_REPO_NAME } else { 'devdeck' }
$script:Api = if ($env:DEVDECK_GITHUB_API) { $env:DEVDECK_GITHUB_API } else { 'https://api.github.com' }

function Write-DevDeckInfo { param([string]$Message) Write-Host "devdeck: $Message" }
function Write-DevDeckWarn { param([string]$Message) Write-Warning "devdeck: $Message" }

# Get-DevDeckArch maps a .NET OSArchitecture (or PROCESSOR_ARCHITECTURE
# fallback) onto a Go GOARCH value.
function Get-DevDeckArch {
    param([string]$Raw)

    if (-not $Raw) {
        try {
            $Raw = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
        }
        catch {
            # RuntimeInformation is unavailable on very old .NET Framework
            # builds; PROCESSOR_ARCHITEW6432 is set when a 32-bit shell runs
            # on a 64-bit OS, so it must be preferred over the plain value.
            $Raw = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
        }
    }

    switch -Regex ($Raw) {
        '^(X64|AMD64)$' { return 'amd64' }
        '^(Arm64|ARM64)$' { return 'arm64' }
        default { throw "unsupported architecture '$Raw' - supported: x64 and arm64" }
    }
}

# Get-DevDeckAssetName must stay byte-identical to selfupdate.AssetName in
# backend/internal/selfupdate/asset.go.
function Get-DevDeckAssetName {
    param([string]$Os, [string]$Arch)

    $name = "devdeck-runtime-$Os-$Arch"
    if ($Os -eq 'windows') { $name = "$name.exe" }
    return $name
}

function Resolve-DevDeckInstallDir {
    if ($env:DEVDECK_INSTALL_DIR) { return $env:DEVDECK_INSTALL_DIR }
    return (Join-Path $env:LOCALAPPDATA 'DevDeck\bin')
}

# Get-DevDeckToken fails early with instructions: the repo is private, so
# there is no anonymous path and a later 404 would be misleading.
function Get-DevDeckToken {
    $token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { $env:GH_TOKEN }
    if (-not $token) {
        throw @"
GITHUB_TOKEN is required - $script:Owner/$script:Repo is a private repository.
  Create a fine-grained token with 'Contents: read' on $script:Owner/$script:Repo at
  https://github.com/settings/personal-access-tokens/new then re-run:
    `$env:GITHUB_TOKEN='ghp_xxx'; irm <this-url> | iex
"@
    }
    return $token
}

function Get-DevDeckRelease {
    param([string]$Token)

    $version = if ($env:DEVDECK_VERSION) { $env:DEVDECK_VERSION } else { 'latest' }
    $url = if ($version -eq 'latest') {
        "$script:Api/repos/$script:Owner/$script:Repo/releases/latest"
    }
    else {
        "$script:Api/repos/$script:Owner/$script:Repo/releases/tags/$version"
    }

    # TLS 1.2 is not the default on Windows PowerShell 5.1; without this the
    # GitHub API call fails with an opaque "could not create SSL/TLS channel".
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

    $headers = @{
        Authorization          = "Bearer $Token"
        Accept                 = 'application/vnd.github+json'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'devdeck-installer'
    }

    try {
        return Invoke-RestMethod -Uri $url -Headers $headers -UseBasicParsing
    }
    catch {
        $status = $null
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        switch ($status) {
            401 { throw "GitHub rejected the token (HTTP 401) - check it is not expired and has 'Contents: read' on $script:Owner/$script:Repo" }
            403 { throw "GitHub rejected the token (HTTP 403) - check it is not expired and has 'Contents: read' on $script:Owner/$script:Repo" }
            404 {
                throw @"
no release found (HTTP 404) - either the token cannot see the private repo $script:Owner/$script:Repo,
  or the tag '$version' does not exist.
  Note: $script:Owner/$script:Repo has no published releases until a v*.*.* tag is pushed.
"@
            }
            default { throw "could not fetch the release metadata: $($_.Exception.Message)" }
        }
    }
}

function Save-DevDeckAsset {
    param([object]$Release, [string]$Name, [string]$Token, [string]$Destination)

    $asset = $Release.assets | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if (-not $asset) {
        throw "release $($Release.tag_name) has no asset named $Name - this platform may not have been built for that release"
    }

    $headers = @{
        Authorization          = "Bearer $Token"
        Accept                 = 'application/octet-stream'
        'X-GitHub-Api-Version' = '2022-11-28'
        'User-Agent'           = 'devdeck-installer'
    }

    Invoke-WebRequest -Uri "$script:Api/repos/$script:Owner/$script:Repo/releases/assets/$($asset.id)" `
        -Headers $headers -OutFile $Destination -UseBasicParsing
}

# Test-DevDeckChecksum mirrors install.sh: a manifest that disagrees is
# fatal, a manifest that is absent is only a warning, because checksums.txt
# is newer than the release workflow.
function Test-DevDeckChecksum {
    param([object]$Release, [string]$Name, [string]$Token, [string]$File, [string]$WorkDir)

    $manifest = $Release.assets | Where-Object { $_.name -eq 'checksums.txt' } | Select-Object -First 1
    if (-not $manifest) {
        Write-DevDeckWarn 'release has no checksums.txt - skipping integrity verification'
        return
    }

    $manifestPath = Join-Path $WorkDir 'checksums.txt'
    Save-DevDeckAsset -Release $Release -Name 'checksums.txt' -Token $Token -Destination $manifestPath

    $line = Get-Content $manifestPath | Where-Object { $_ -match "\s\*?$([regex]::Escape($Name))$" } | Select-Object -First 1
    if (-not $line) {
        Write-DevDeckWarn "checksums.txt has no entry for $Name - skipping integrity verification"
        return
    }

    $want = ($line -split '\s+')[0]
    $got = (Get-FileHash -Path $File -Algorithm SHA256).Hash.ToLower()
    if ($got -ne $want.ToLower()) {
        throw "checksum mismatch for ${Name}: expected $want, got $got. Nothing was installed."
    }
    Write-DevDeckInfo 'checksum verified'
}

function Install-DevDeckBinary {
    param([string]$Source)

    $dir = Resolve-DevDeckInstallDir
    New-Item -ItemType Directory -Path $dir -Force | Out-Null

    $target = Join-Path $dir 'devdeck.exe'
    Move-Item -Path $Source -Destination $target -Force
    Write-DevDeckInfo "installed $target"

    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($userPath -notlike "*$dir*") {
        Write-DevDeckWarn "$dir is not on your PATH - add it with:`n    setx PATH `"$dir;%PATH%`""
    }

    return $target
}

function Get-DevDeckConfigPath {
    return (Join-Path $env:APPDATA 'DevDeck\runtime.env')
}

function Get-DevDeckLogPath {
    return (Join-Path $env:LOCALAPPDATA 'DevDeck\runtime.log')
}

function New-DevDeckKey {
    $bytes = New-Object 'System.Byte[]' 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-DevDeckPublicUrl {
    param([string]$Port)

    $ts = Get-Command tailscale -ErrorAction SilentlyContinue
    if ($ts) {
        $ip = (& tailscale ip -4 2>$null | Select-Object -First 1)
        if ($ip) { return "http://${ip}:$Port" }
    }

    $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.PrefixOrigin -ne 'WellKnown' } |
        Select-Object -First 1).IPAddress
    if (-not $ip) { $ip = $env:COMPUTERNAME }
    return "http://${ip}:$Port"
}

function Register-DevDeckRuntime {
    param([string]$BinaryPath)

    $role = if ($env:DEVDECK_ROLE) { $env:DEVDECK_ROLE } else { 'runtime' }
    if ($role -notin @('runtime', 'hub', 'both')) {
        throw "DEVDECK_ROLE must be runtime, hub, or both - got '$role'"
    }

    $addr = if ($env:DEVDECK_ADDR) { $env:DEVDECK_ADDR } else { '0.0.0.0:8989' }
    $port = $addr.Split(':')[-1]
    $key = if ($env:DEVDECK_KEY) { $env:DEVDECK_KEY } else { New-DevDeckKey }
    $name = if ($env:DEVDECK_MACHINE_NAME) { $env:DEVDECK_MACHINE_NAME } else { $env:COMPUTERNAME }
    $publicUrl = if ($env:DEVDECK_PUBLIC_URL) { $env:DEVDECK_PUBLIC_URL } else { Get-DevDeckPublicUrl -Port $port }

    $cfg = Get-DevDeckConfigPath
    New-Item -ItemType Directory -Path (Split-Path $cfg) -Force | Out-Null
    if (Test-Path $cfg) {
        Copy-Item $cfg "$cfg.bak" -Force
        Write-DevDeckWarn "existing config backed up to $cfg.bak"
    }

    @(
        '# Generated by the DevDeck installer.'
        "DEVDECK_ROLE=$role"
        "DEVDECK_KEY=$key"
        "DEVDECK_ADDR=$addr"
        "DEVDECK_HUB_URL=$($env:DEVDECK_HUB_URL)"
        "DEVDECK_HUB_KEY=$($env:DEVDECK_HUB_KEY)"
        "DEVDECK_PUBLIC_URL=$publicUrl"
        "DEVDECK_MACHINE_NAME=$name"
    ) | Set-Content -Path $cfg -Encoding ASCII
    Write-DevDeckInfo "wrote $cfg"

    if ($env:DEVDECK_NO_START -eq '1') {
        Write-DevDeckInfo "DEVDECK_NO_START=1 - not starting. Start it with:`n    $BinaryPath --open=false"
        return
    }

    $env:DEVDECK_ROLE = $role
    $env:DEVDECK_KEY = $key
    $env:DEVDECK_ADDR = $addr
    $env:DEVDECK_PUBLIC_URL = $publicUrl
    $env:DEVDECK_MACHINE_NAME = $name

    $log = Get-DevDeckLogPath
    New-Item -ItemType Directory -Path (Split-Path $log) -Force | Out-Null
    $proc = Start-Process -FilePath $BinaryPath -ArgumentList '--open=false' `
        -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru
    Write-DevDeckInfo "started pid $($proc.Id), logging to $log"

    $healthy = $false
    for ($i = 0; $i -lt 30; $i++) {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
            $healthy = $true
            break
        }
        catch { Start-Sleep -Seconds 1 }
    }
    if (-not $healthy) { throw "the runtime did not become healthy within 30s - check $log" }
    Write-DevDeckInfo 'runtime is healthy'

    $machines = Invoke-RestMethod -Uri "$($env:DEVDECK_HUB_URL)/api/machines" `
        -Headers @{ Authorization = "Bearer $($env:DEVDECK_HUB_KEY)"; 'User-Agent' = 'devdeck-installer' } -UseBasicParsing
    if ($machines | Where-Object { $_.name -eq $name }) {
        Write-DevDeckInfo "registered with the hub as '$name'"
    }
    else {
        throw "the runtime is running but did not appear in $($env:DEVDECK_HUB_URL)/api/machines as '$name' - check $log"
    }

    Write-DevDeckInfo "note: this process does not survive a reboot - no service was installed."
}

function Invoke-DevDeckInstall {
    if (-not $IsWindowsHost) {
        throw 'install.ps1 targets Windows - on Linux and macOS use install.sh'
    }

    $arch = Get-DevDeckArch -Raw ''
    Write-DevDeckInfo "detected windows/$arch"

    $token = Get-DevDeckToken
    $name = Get-DevDeckAssetName -Os 'windows' -Arch $arch

    $workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("devdeck-" + [System.Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $workDir -Force | Out-Null
    try {
        Write-DevDeckInfo "resolving $(if ($env:DEVDECK_VERSION) { $env:DEVDECK_VERSION } else { 'latest' }) release..."
        $release = Get-DevDeckRelease -Token $token

        Write-DevDeckInfo "downloading $name..."
        $downloaded = Join-Path $workDir $name
        Save-DevDeckAsset -Release $release -Name $name -Token $token -Destination $downloaded

        Test-DevDeckChecksum -Release $release -Name $name -Token $token -File $downloaded -WorkDir $workDir
        $installed = Install-DevDeckBinary -Source $downloaded

        if ($env:DEVDECK_HUB_URL -and $env:DEVDECK_HUB_KEY) {
            Register-DevDeckRuntime -BinaryPath $installed
        }
        else {
            Write-DevDeckInfo @"
install complete. To register this machine as a runtime, re-run with
  `$env:DEVDECK_HUB_URL and `$env:DEVDECK_HUB_KEY set, or start it yourself:
    $installed --role runtime --key <key> --hub-url <url> --hub-key <key>
"@
        }
    }
    finally {
        Remove-Item -Recurse -Force $workDir -ErrorAction SilentlyContinue
    }
}

# $IsWindows exists only on PowerShell 6+; on 5.1 the platform is always
# Windows. Computed before use so `irm | iex` and dot-sourcing agree.
$script:IsWindowsHost = if ($PSVersionTable.PSVersion.Major -ge 6) { $IsWindows } else { $true }

if ($env:DEVDECK_INSTALL_TEST -ne '1') {
    Invoke-DevDeckInstall
}

#Requires -Version 5.1
# Assertion checks for the pure helpers in scripts/install.ps1.
# Run: pwsh -NoProfile -File scripts/test/install_ps_test.ps1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$env:DEVDECK_INSTALL_TEST = '1'

# LOCALAPPDATA and APPDATA are Windows-only, but these assertions cover pure
# helpers that are worth running anywhere pwsh exists — including the Linux CI
# runner and a macOS dev machine. Standing in a temp path keeps the harness
# self-sufficient instead of pushing the requirement onto every caller.
if (-not $env:LOCALAPPDATA) { $env:LOCALAPPDATA = [System.IO.Path]::GetTempPath() }
if (-not $env:APPDATA) { $env:APPDATA = [System.IO.Path]::GetTempPath() }

. (Join-Path (Split-Path $PSScriptRoot -Parent) 'install.ps1')

$passed = 0
$failed = 0

function Assert-Eq {
    param([string]$Desc, $Got, $Want)
    if ($Got -eq $Want) { $script:passed++ }
    else {
        $script:failed++
        Write-Host "FAIL: $Desc`n  got:  $Got`n  want: $Want" -ForegroundColor Red
    }
}

function Assert-Throws {
    param([string]$Desc, [scriptblock]$Action)
    try { & $Action | Out-Null; $script:failed++; Write-Host "FAIL: $Desc (expected a throw)" -ForegroundColor Red }
    catch { $script:passed++ }
}

Assert-Eq 'asset name amd64' (Get-DevDeckAssetName -Os 'windows' -Arch 'amd64') 'devdeck-runtime-windows-amd64.exe'
Assert-Eq 'asset name arm64' (Get-DevDeckAssetName -Os 'windows' -Arch 'arm64') 'devdeck-runtime-windows-arm64.exe'
Assert-Eq 'arch X64' (Get-DevDeckArch -Raw 'X64') 'amd64'
Assert-Eq 'arch AMD64' (Get-DevDeckArch -Raw 'AMD64') 'amd64'
Assert-Eq 'arch Arm64' (Get-DevDeckArch -Raw 'Arm64') 'arm64'
Assert-Throws 'arch X86 is rejected' { Get-DevDeckArch -Raw 'X86' }

$env:DEVDECK_INSTALL_DIR = 'C:\dd'
Assert-Eq 'install dir override' (Resolve-DevDeckInstallDir) 'C:\dd'
$env:DEVDECK_INSTALL_DIR = ''
Assert-Eq 'install dir default' (Resolve-DevDeckInstallDir) (Join-Path $env:LOCALAPPDATA 'DevDeck\bin')

$key = New-DevDeckKey
Assert-Eq 'key length' $key.Length 64
Assert-Eq 'key is hex' ($key -match '^[0-9a-f]{64}$') $true
Assert-Eq 'key is not constant' ($key -ne (New-DevDeckKey)) $true

$env:GITHUB_TOKEN = ''
$env:GH_TOKEN = ''
Assert-Throws 'missing token is rejected' { Get-DevDeckToken }
$env:GITHUB_TOKEN = 'aaa'
Assert-Eq 'token from GITHUB_TOKEN' (Get-DevDeckToken) 'aaa'

# A checksums.txt download failure (transient CDN blip, connection reset)
# must warn and skip verification, matching install.sh's `|| true` on the
# same fetch - not abort the whole install after the real binary already
# downloaded. Save-DevDeckAsset is shadowed here to simulate that failure
# without touching the network.
function Save-DevDeckAsset {
    param([object]$Release, [string]$Name, [string]$Token, [string]$Destination)
    throw 'simulated network failure fetching checksums.txt'
}
$fakeRelease = [PSCustomObject]@{
    tag_name = 'v1.0.0'
    assets   = @([PSCustomObject]@{ name = 'checksums.txt'; id = 999 })
}
$tmpFile = [System.IO.Path]::GetTempFileName()
$threw = $false
try {
    Test-DevDeckChecksum -Release $fakeRelease -Name 'devdeck-runtime-windows-amd64.exe' `
        -Token 'tok' -File $tmpFile -WorkDir ([System.IO.Path]::GetTempPath())
}
catch { $threw = $true }
finally { Remove-Item $tmpFile -ErrorAction SilentlyContinue }
Assert-Eq 'checksums.txt fetch failure warns instead of aborting' $threw $false

Write-Host "`n$passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }

@echo off
:: DevDeck installer shim for cmd.exe.
::
::   curl -fsSL https://kiyora.is-a.dev/devdeck/install.cmd -o %TEMP%\dd.cmd && %TEMP%\dd.cmd
::
:: All the work happens in install.ps1. This file exists so the documented
:: cmd.exe path is something a user can download and read, rather than a
:: quoted one-liner they have to trust sight-unseen.
::
:: GITHUB_TOKEN and the DEVDECK_* variables need no forwarding - the
:: PowerShell child process inherits this shell's environment.
setlocal

if "%DEVDECK_INSTALL_URL%"=="" set "DEVDECK_INSTALL_URL=https://kiyora.is-a.dev/devdeck/install.ps1"

powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '%DEVDECK_INSTALL_URL%' | iex"
set "RC=%ERRORLEVEL%"

endlocal & exit /b %RC%

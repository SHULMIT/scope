#Requires -Version 5.1

[CmdletBinding()]
param(
    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string]$Distribution = 'Ubuntu'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$dockerPackageId = 'Docker.DockerDesktop'
$scopeSetupUrl = 'https://gist.githubusercontent.com/cmaneu/03e857b16ee36788962a9355d738970b/raw/eb4b3f29e821f15fcf53e9ba8589cae0ded99e9a/scope-setup.sh'

function Invoke-NativeCommand {
    param(
        [Parameter(Mandatory)]
        [string]$FilePath,

        [Parameter()]
        [string[]]$Arguments = @()
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        $renderedArguments = $Arguments -join ' '
        throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $renderedArguments"
    }
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-WslDistributions {
    $output = & wsl.exe --list --quiet
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to list WSL distributions (exit code $LASTEXITCODE)."
    }

    return @(
        $output |
            ForEach-Object { "$_".Replace([string][char]0, '').Trim() } |
            Where-Object { $_ }
    )
}

function Test-DockerDesktopInstalled {
    $knownExecutables = @(
        (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe')
    )

    if ($knownExecutables | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }) {
        return $true
    }

    $uninstallRoots = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
    )

    foreach ($root in $uninstallRoots) {
        if (-not (Test-Path -LiteralPath $root)) {
            continue
        }

        foreach ($entry in Get-ChildItem -LiteralPath $root) {
            if ($entry.GetValue('DisplayName') -eq 'Docker Desktop') {
                return $true
            }
        }
    }

    return $false
}

function Confirm-DockerDesktopInstall {
    while ($true) {
        $answer = (Read-Host 'Docker Desktop is not installed. Install it now with the WSL 2 backend? [Y/n]').Trim()

        if ([string]::IsNullOrEmpty($answer) -or $answer -match '^[Yy]$') {
            return $true
        }

        if ($answer -match '^[Nn]$') {
            return $false
        }

        Write-Warning 'Enter Y or N.'
    }
}

if (-not (Test-IsAdministrator)) {
    throw 'Run this script from an elevated PowerShell session (Run as administrator).'
}

if (-not (Get-Command wsl.exe -ErrorAction Ignore)) {
    throw 'wsl.exe is unavailable. Install WSL with "wsl --install", restart Windows, and rerun this script.'
}

Write-Host 'Configuring WSL 2...' -ForegroundColor Cyan
Invoke-NativeCommand -FilePath 'wsl.exe' -Arguments @('--update')
Invoke-NativeCommand -FilePath 'wsl.exe' -Arguments @('--set-default-version', '2')

$installedDistributions = Get-WslDistributions
if ($Distribution -notin $installedDistributions) {
    Write-Host "Installing $Distribution without launching it..." -ForegroundColor Cyan
    Invoke-NativeCommand -FilePath 'wsl.exe' -Arguments @(
        '--install',
        '--distribution', $Distribution,
        '--no-launch'
    )

    $installedDistributions = Get-WslDistributions
    if ($Distribution -notin $installedDistributions) {
        throw "$Distribution was requested but is not registered yet. Restart Windows, then rerun this script."
    }
}
else {
    Write-Host "$Distribution is already installed." -ForegroundColor Green
}

Invoke-NativeCommand -FilePath 'wsl.exe' -Arguments @('--set-version', $Distribution, '2')
Invoke-NativeCommand -FilePath 'wsl.exe' -Arguments @('--set-default', $Distribution)

if (Test-DockerDesktopInstalled) {
    Write-Host 'Docker Desktop is already installed.' -ForegroundColor Green
}
elseif (Confirm-DockerDesktopInstall) {
    if (-not (Get-Command winget.exe -ErrorAction Ignore)) {
        throw 'WinGet is unavailable. Install or update Microsoft App Installer, then rerun this script.'
    }

    Write-Host 'Installing Docker Desktop with the WSL 2 backend...' -ForegroundColor Cyan
    Invoke-NativeCommand -FilePath 'winget.exe' -Arguments @(
        'install',
        '--exact',
        '--id', $dockerPackageId,
        '--silent',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
        '--custom', '--accept-license --backend=wsl-2'
    )

    if (-not (Test-DockerDesktopInstalled)) {
        throw 'WinGet completed, but Docker Desktop could not be found.'
    }

    Write-Host 'Docker Desktop was installed successfully.' -ForegroundColor Green
}
else {
    Write-Warning 'Docker Desktop installation was skipped. Install it before running Scope.'
}

$scopeSetupCommand = "curl -fsSL '$scopeSetupUrl' -o /tmp/scope-setup.sh && bash /tmp/scope-setup.sh --skip-docker"

Write-Host @"

Windows-side setup is complete.

Next steps:
1. Launch $Distribution from the Start menu and finish its first-run prompt to create your Linux user.
2. Launch Docker Desktop and wait for it to finish initializing its WSL 2 engine for your Windows user.
3. Open $Distribution again and run:

$scopeSetupCommand

The --skip-docker option keeps the Linux setup script from installing a second Docker Engine inside WSL.
"@ -ForegroundColor Green

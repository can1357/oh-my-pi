# Pi Coding Agent Installer for Windows
# Usage: irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1))) -Source
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1))) -Binary

param(
    [switch]$Source,
    [switch]$Binary
)

$ErrorActionPreference = "Stop"

$Repo = "can1357/oh-my-pi"
$Package = "@oh-my-pi/pi-coding-agent"
$InstallDir = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { "$env:LOCALAPPDATA\pi" }
$BinaryName = "pi-windows-x64.exe"

function Test-BunInstalled {
    try {
        $null = Get-Command bun -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Install-Bun {
    Write-Host "Installing bun..."
    irm bun.sh/install.ps1 | iex
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
}

function Install-ViaBun {
    Write-Host "Installing via bun..."
    bun install -g $Package
    Write-Host ""
    Write-Host "✓ Installed pi via bun" -ForegroundColor Green
    Write-Host "Run 'pi' to get started!"
}

function Install-Binary {
    # Get latest release
    Write-Host "Fetching latest release..."
    $Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
    $Latest = $Release.tag_name
    Write-Host "Latest version: $Latest"

    # Download binary
    $Url = "https://github.com/$Repo/releases/download/$Latest/$BinaryName"
    Write-Host "Downloading $BinaryName..."

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $OutPath = Join-Path $InstallDir "pi.exe"
    Invoke-WebRequest -Uri $Url -OutFile $OutPath

    Write-Host ""
    Write-Host "✓ Installed pi to $OutPath" -ForegroundColor Green

    # Add to PATH if not already there
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($UserPath -notlike "*$InstallDir*") {
        Write-Host "Adding $InstallDir to PATH..."
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
        Write-Host "Restart your terminal, then run 'pi' to get started!"
    } else {
        Write-Host "Run 'pi' to get started!"
    }
}

# Main logic
if ($Source) {
    if (-not (Test-BunInstalled)) {
        Install-Bun
    }
    Install-ViaBun
} elseif ($Binary) {
    Install-Binary
} else {
    # Default: use bun if available, otherwise binary
    if (Test-BunInstalled) {
        Install-ViaBun
    } else {
        Install-Binary
    }
}

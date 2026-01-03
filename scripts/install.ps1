# Pi Coding Agent Installer for Windows
# Usage: irm https://raw.githubusercontent.com/can1357/oh-my-pi/main/scripts/install.ps1 | iex

$ErrorActionPreference = "Stop"

$Repo = "can1357/oh-my-pi"
$InstallDir = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { "$env:LOCALAPPDATA\pi" }
$Binary = "pi-windows-x64.exe"

# Get latest release
Write-Host "Fetching latest release..."
$Release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest"
$Latest = $Release.tag_name
Write-Host "Latest version: $Latest"

# Download binary
$Url = "https://github.com/$Repo/releases/download/$Latest/$Binary"
Write-Host "Downloading $Binary..."

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$OutPath = Join-Path $InstallDir "pi.exe"
Invoke-WebRequest -Uri $Url -OutFile $OutPath

Write-Host ""
Write-Host "Installed pi to $OutPath"

# Add to PATH if not already there
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    Write-Host "Adding $InstallDir to PATH..."
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    Write-Host "Restart your terminal, then run 'pi' to get started!"
} else {
    Write-Host "Run 'pi' to get started!"
}

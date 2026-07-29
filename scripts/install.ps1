# oh-my-pk installer for Windows
# Usage: irm https://oh-my-pk.pkking.computer/install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm https://oh-my-pk.pkking.computer/install.ps1))) -Source
#   & ([scriptblock]::Create((irm https://oh-my-pk.pkking.computer/install.ps1))) -Binary
#   & ([scriptblock]::Create((irm https://oh-my-pk.pkking.computer/install.ps1))) -Source -Ref v3.20.1
#   & ([scriptblock]::Create((irm https://oh-my-pk.pkking.computer/install.ps1))) -Source -Ref main
#   & ([scriptblock]::Create((irm https://oh-my-pk.pkking.computer/install.ps1))) -Binary -Ref v3.20.1

param(
    [switch]$Source,
    [switch]$Binary,
    [string]$Ref
)

$ErrorActionPreference = "Stop"

$Repo = "kingkillery/oh-my-pk"
$DistBase = if ($env:OMP_DIST_BASE) { $env:OMP_DIST_BASE } else { "https://oh-my-pk.pkking.computer" }
$Package = "@pk-nerdsaver-ai/pi-coding-agent"
$InstallDir = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { "$env:LOCALAPPDATA\omp" }
$BinaryName = "omp-windows-x64.exe"
$MinimumBunVersion = "1.3.14"

function Test-BunInstalled {
    try {
        $null = Get-Command bun -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Get-BunVersion {
    try {
        $versionText = (bun --version 2>$null)
        if (-not $versionText) {
            return $null
        }

        $clean = $versionText.Trim().Split("-")[0]
        return [version]$clean
    } catch {
        return $null
    }
}

function Test-BunVersion {
    param([string]$MinimumVersion)

    $currentVersion = Get-BunVersion
    if (-not $currentVersion) {
        return $false
    }

    return $currentVersion -ge [version]$MinimumVersion
}

function Assert-BunVersion {
    param([string]$MinimumVersion)

    if (-not (Test-BunVersion $MinimumVersion)) {
        $current = Get-BunVersion
        $currentText = if ($current) { $current.ToString() } else { "unknown" }
        throw "Bun $MinimumVersion or newer is required. Current version: $currentText. Upgrade Bun at https://bun.sh/docs/installation"
    }
}

function Test-GitInstalled {
    try {
        $null = Get-Command git -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Test-GitLfsInstalled {
    try {
        $null = Get-Command git-lfs -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Find-BashShell {
    # Check Git Bash first (most common on Windows)
    $gitBash = "C:\Program Files\Git\bin\bash.exe"
    if (Test-Path $gitBash) {
        return $gitBash
    }

    # Check bash.exe on PATH (Cygwin, MSYS2, WSL)
    try {
        $bashCmd = Get-Command bash.exe -ErrorAction Stop
        return $bashCmd.Source
    } catch {
        return $null
    }
}

function Configure-BashShell {
    try {
        $settingsDir = Join-Path $env:USERPROFILE ".ompk\agent"
        $settingsFile = Join-Path $settingsDir "settings.json"

        # Check if settings.json already has a shellPath configured
        if (Test-Path $settingsFile) {
            try {
                $existingSettings = Get-Content $settingsFile -Raw | ConvertFrom-Json
                if ($existingSettings.shellPath) {
                    Write-Host "Bash shell already configured: $($existingSettings.shellPath)" -ForegroundColor Cyan
                    return
                }
            } catch {
                # Invalid JSON, we'll overwrite it
            }
        }

        $bashPath = Find-BashShell

        if ($bashPath) {
            Write-Host "Found bash shell: $bashPath" -ForegroundColor Cyan

            # Create settings directory if needed
            if (-not (Test-Path $settingsDir)) {
                New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
            }

            # Read existing settings or create new
            $settings = @{}
            if (Test-Path $settingsFile) {
                try {
                    $settings = Get-Content $settingsFile -Raw | ConvertFrom-Json -AsHashtable
                } catch {
                    $settings = @{}
                }
            }

            # Set shellPath
            $settings["shellPath"] = $bashPath

            # Write settings
            $settings | ConvertTo-Json -Depth 10 | Set-Content $settingsFile -Encoding UTF8
            Write-Host "[OK] Configured shell path in $settingsFile" -ForegroundColor Green
        } else {
            Write-Host ""
            Write-Host "[WARN] No bash shell found!" -ForegroundColor Yellow
            Write-Host "  oh-my-pk requires a bash shell on Windows. Options:" -ForegroundColor Yellow
            Write-Host "    1. Install Git for Windows: https://git-scm.com/download/win" -ForegroundColor Yellow
            Write-Host "    2. Use WSL, Cygwin, or MSYS2" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "  After installing, you can set a custom path in:" -ForegroundColor Yellow
            Write-Host "    $settingsFile" -ForegroundColor Yellow
            Write-Host '    { "shellPath": "C:\\path\\to\\bash.exe" }' -ForegroundColor Yellow
        }
    } catch {
        Write-Host "[WARN] Could not configure bash shell: $_" -ForegroundColor Yellow
    }
}

function Install-Bun {
    Write-Host "Installing bun..."
    irm bun.sh/install.ps1 | iex
    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "User") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "Machine")
    Assert-BunVersion $MinimumBunVersion
}

function Install-ViaBun {
    Write-Host "Installing via bun..."
    if ($Ref) {
        if (-not (Test-GitInstalled)) {
            throw "git is required for -Ref when installing from source"
        }

        $tmpRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("omp-install-" + [System.Guid]::NewGuid().ToString("N"))
        New-Item -ItemType Directory -Force -Path $tmpRoot | Out-Null

        try {
            $repoUrl = "https://github.com/$Repo.git"
            $cloneOk = $false
            try {
                git clone --depth 1 --branch $Ref $repoUrl $tmpRoot | Out-Null
                $cloneOk = $true
            } catch {
                $cloneOk = $false
            }

            if (-not $cloneOk) {
                git clone $repoUrl $tmpRoot | Out-Null
                Push-Location $tmpRoot
                try {
                    git checkout $Ref | Out-Null
                } finally {
                    Pop-Location
                }
            }

            # Pull LFS files
            if (Test-GitLfsInstalled) {
                Push-Location $tmpRoot
                try {
                    git lfs pull | Out-Null
                } finally {
                    Pop-Location
                }
            }

            $packagePath = Join-Path $tmpRoot "packages\coding-agent"
            if (-not (Test-Path $packagePath)) {
                throw "Expected package at $packagePath"
            }

            bun install -g $packagePath
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to install from $packagePath via bun"
            }
        } finally {
            Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue
        }
    } else {
        bun install -g $Package
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install $Package via bun"
        }
    }

    Write-Host ""
    Write-Host "[OK] Installed oh-my-pk via bun" -ForegroundColor Green

    Configure-BashShell

    Write-Host "Run 'oh-my-pk' (or 'ompk') to get started!"
}

function Install-Binary {
    # Resolve version: an explicit -Ref pins the tag; otherwise ask the
    # distribution endpoint (Cloudflare Worker -> private Hugging Face repo).
    if ($Ref) {
        $Latest = $Ref
    } else {
        Write-Host "Fetching latest version..."
        $Latest = (Invoke-RestMethod -Uri "$DistBase/version").ToString().Trim()
    }

    if (-not $Latest) {
        throw "Failed to resolve version"
    }
    Write-Host "Using version: $Latest"

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # Download binary from the distribution endpoint (no GitHub dependency).
    $BinaryUrl = "$DistBase/bin/$Latest/$BinaryName"
    Write-Host "Downloading $BinaryName..."
    $OutPath = Join-Path $InstallDir "oh-my-pk.exe"
    Invoke-WebRequest -Uri $BinaryUrl -OutFile $OutPath
    # Keep `omp` and `ompk` as launch aliases for the renamed command.
    Copy-Item -Path $OutPath -Destination (Join-Path $InstallDir "omp.exe") -Force
    Copy-Item -Path $OutPath -Destination (Join-Path $InstallDir "ompk.exe") -Force

    Write-Host ""
    Write-Host "[OK] Installed oh-my-pk to $OutPath (aliases: omp.exe, ompk.exe)" -ForegroundColor Green

    # Add to PATH if not already there
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $needsRestart = $UserPath -notlike "*$InstallDir*"
    if ($needsRestart) {
        Write-Host "Adding $InstallDir to PATH..."
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    }

    Configure-BashShell

    if ($needsRestart) {
        Write-Host "Restart your terminal, then run 'oh-my-pk' (or 'ompk') to get started!"
    } else {
        Write-Host "Run 'oh-my-pk' (or 'ompk') to get started!"
    }
}

# Main logic
if ($Ref -and -not $Source -and -not $Binary) {
    $Source = $true
}

if ($Source) {
    if (-not (Test-BunInstalled)) {
        Install-Bun
    }
    Assert-BunVersion $MinimumBunVersion
    Install-ViaBun
} elseif ($Binary) {
    Install-Binary
} else {
    # Default: install/validate bun (if needed) and use the npm package.
    # Pass -Binary explicitly to always fetch the prebuilt binary instead.
    if (-not (Test-BunInstalled)) {
        Install-Bun
    }
    Assert-BunVersion $MinimumBunVersion
    Install-ViaBun
}

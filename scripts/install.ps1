# OMP Coding Agent Installer for Windows
# Usage: irm https://omp.sh/install.ps1 | iex
#
# Or with options:
#   & ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Source
#   & ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Binary
#   & ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Source -Ref v18.8.9
#   & ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Source -Ref main
#   & ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Binary -Ref v18.8.9
#   & ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Uninstall
#   & ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Purge
#
# The prebuilt binary is the default, since it updates itself with delta
# patches; -Source installs the package via bun and is implied by a bare -Ref.
# -Ref takes any tag/commit/branch with -Source; binary installs take a release
# tag (v<version>). Prebuilt binaries come from the build service
# ($env:PI_BUILD_URL, default https://build.stencil.so) and are checked against
# its sha256 before install.
#
# -Uninstall removes omp: the binary this script installs (and the user PATH
# entry it added), or the bun/npm global package. It keeps omp's state
# directory (%USERPROFILE%\.omp, or $env:PI_CONFIG_DIR under the profile)
# unless you confirm at the prompt; -Purge uninstalls and deletes that state
# without asking.

param(
    [switch]$Source,
    [switch]$Binary,
    [string]$Ref,
    [switch]$Uninstall,
    [switch]$Purge
)

$ErrorActionPreference = "Stop"

# Fail fast on hosts older than Windows PowerShell 5.1: cmdlets used below
# (e.g. Invoke-WebRequest -TimeoutSec) are missing or unreliable there and
# fail with cryptic errors halfway through the install. Anything newer,
# including PowerShell 7+, passes this check.
if ($PSVersionTable.PSVersion -lt [version]"5.1") {
    throw "Windows PowerShell 5.1 or newer is required (found $($PSVersionTable.PSVersion)). Install PowerShell 7 from https://aka.ms/powershell and re-run the installer."
}

$Repo = "can1357/oh-my-pi"
$Package = "@oh-my-pi/pi-coding-agent"
$InstallDir = if ($env:PI_INSTALL_DIR) { $env:PI_INSTALL_DIR } else { "$env:LOCALAPPDATA\omp" }
$BuildUrl = if ($env:PI_BUILD_URL) { $env:PI_BUILD_URL.TrimEnd("/") } else { "https://build.stencil.so" }
# Windows PowerShell 5.1 (.NET Framework) does not reliably resolve
# [System.Runtime.InteropServices.RuntimeInformation] without an
# assembly-qualified name, while PowerShell 7+ (Core) loads that type from a
# different assembly — so read the OS architecture from the environment
# instead, which works on both. Prefer PROCESSOR_ARCHITEW6432 so a 32-bit
# host on 64-bit Windows still reports the OS architecture.
# Note: PROCESSOR_ARCHITEW6432 is only set for 32-bit (WOW64) processes, so
# x64 PowerShell under ARM64 emulation reports AMD64 and installs the x64
# binary (runs emulated, not natively). Native ARM64 and x86-on-ARM64 hosts
# still resolve to arm64.
$RawArchitecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if (-not $RawArchitecture) {
    throw "Unable to determine Windows architecture"
}
$BuildTarget = switch ($RawArchitecture.ToUpperInvariant()) {
    "AMD64" { "windows-x86_64" }
    "ARM64" { "windows-arm64" }
    default { throw "Unsupported Windows architecture: $RawArchitecture" }
}
$MinimumBunVersion = "1.4.4"

# PowerShell 5.1 raises a terminating NativeCommandError for any line a native
# executable writes to stderr while $ErrorActionPreference is "Stop", regardless
# of the process exit code. Tools like bun and git emit normal progress on
# stderr, so run them with the preference relaxed to "Continue" and let callers
# gate on $LASTEXITCODE. Global "Stop" stays in effect for the cmdlet-driven
# operations (Invoke-WebRequest/Invoke-RestMethod) that depend on it.
function Invoke-Native {
    param([Parameter(Mandatory = $true)][scriptblock]$Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        & $Command
    } finally {
        $ErrorActionPreference = $previous
    }
}

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
        $settingsDir = Join-Path $env:USERPROFILE ".omp\agent"
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

            # Read existing settings or create new. ConvertFrom-Json -AsHashtable
            # requires PowerShell 6+; build the hashtable manually so Windows
            # PowerShell 5.1 merges instead of clobbering existing settings.
            $settings = @{}
            if (Test-Path $settingsFile) {
                try {
                    $parsed = Get-Content $settingsFile -Raw | ConvertFrom-Json
                    foreach ($prop in $parsed.PSObject.Properties) {
                        $settings[$prop.Name] = $prop.Value
                    }
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
            Write-Host "No bash shell found - OMP will use its built-in shell." -ForegroundColor Cyan
            Write-Host "  For shell snapshots and interactive terminals, install Git for Windows:" -ForegroundColor Cyan
            Write-Host "    https://git-scm.com/download/win" -ForegroundColor Cyan
            Write-Host "  Or set a custom path in:" -ForegroundColor Cyan
            Write-Host "    $settingsFile" -ForegroundColor Cyan
            Write-Host '    { "shellPath": "C:\\path\\to\\bash.exe" }' -ForegroundColor Cyan
        }
    } catch {
        Write-Host "[WARN] Could not configure bash shell: $_" -ForegroundColor Yellow
    }
}

function Install-Bun {
    Write-Host "Installing bun..."
    Invoke-Native { irm bun.sh/install.ps1 | iex }
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
            Invoke-Native { git clone --depth 1 --branch $Ref $repoUrl $tmpRoot 2>&1 | Out-Null }
            if ($LASTEXITCODE -ne 0) {
                Invoke-Native { git clone $repoUrl $tmpRoot 2>&1 | Out-Null }
                if ($LASTEXITCODE -ne 0) {
                    throw "Failed to clone $repoUrl"
                }
                Push-Location $tmpRoot
                try {
                    Invoke-Native { git checkout $Ref 2>&1 | Out-Null }
                    if ($LASTEXITCODE -ne 0) {
                        throw "Failed to checkout $Ref"
                    }
                } finally {
                    Pop-Location
                }
            }

            # Pull LFS files
            if (Test-GitLfsInstalled) {
                Push-Location $tmpRoot
                try {
                    Invoke-Native { git lfs pull 2>&1 | Out-Null }
                } finally {
                    Pop-Location
                }
            }

            $packagePath = Join-Path $tmpRoot "packages\coding-agent"
            if (-not (Test-Path $packagePath)) {
                throw "Expected package at $packagePath"
            }

            Invoke-Native { bun install -g $packagePath }
            if ($LASTEXITCODE -ne 0) {
                throw "Failed to install from $packagePath via bun"
            }
        } finally {
            Remove-Item -Recurse -Force $tmpRoot -ErrorAction SilentlyContinue
        }
    } else {
        Invoke-Native { bun install -g $Package }
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install $Package via bun"
        }
    }

    Write-Host ""
    Write-Host "[OK] Installed omp via bun" -ForegroundColor Green

    Configure-BashShell

    Write-Host "Run 'omp' to get started!"
}

function Install-Binary {
    if ($Ref) {
        if ($Ref -notmatch '^v(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$') {
            throw "Binary installs take a release tag (v<version>) for -Ref, got: $Ref`nFor branch/commit installs, use -Source with -Ref."
        }
        $RequestedVersion = $Matches[1]
        Write-Host "Fetching omp $RequestedVersion..."
        $ApiUrl = "$BuildUrl/api/products/omp/versions/$RequestedVersion/$BuildTarget"
    } else {
        Write-Host "Fetching latest release..."
        $ApiUrl = "$BuildUrl/api/products/omp/latest/${BuildTarget}?channel=stable"
    }
    try {
        $Answer = Invoke-RestMethod -Uri $ApiUrl -TimeoutSec 60
    } catch {
        throw "Failed to resolve an omp build for $BuildTarget from ${ApiUrl}: $_"
    }

    $Version = $Answer.build.version
    $BinaryName = $Answer.file.name
    $ExpectedSha256 = "$($Answer.file.sha256)".ToLowerInvariant()
    $DownloadUrl = $Answer.download
    if (-not $Version -or -not $BinaryName -or -not $DownloadUrl -or $ExpectedSha256 -notmatch '^[0-9a-f]{64}$') {
        throw "Unexpected answer from $ApiUrl"
    }
    Write-Host "Using version: $Version"

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # Download next to the destination and move it into place only once the
    # checksum matches, so a bad download never replaces a working omp.
    Write-Host "Downloading $BinaryName..."
    $OutPath = Join-Path $InstallDir "omp.exe"
    $DownloadPath = Join-Path $InstallDir ".omp.download.exe"
    try {
        Invoke-WebRequest -Uri $DownloadUrl -OutFile $DownloadPath -TimeoutSec 900
        $ActualSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $DownloadPath).Hash.ToLowerInvariant()
        if ($ActualSha256 -ne $ExpectedSha256) {
            throw "Checksum mismatch for ${BinaryName}: expected $ExpectedSha256, got $ActualSha256"
        }
        Move-Item -Force -LiteralPath $DownloadPath -Destination $OutPath
    } finally {
        Remove-Item -Force -LiteralPath $DownloadPath -ErrorAction SilentlyContinue
    }

    Write-Host ""
    Write-Host "[OK] Installed omp to $OutPath" -ForegroundColor Green

    # Add to PATH if not already there
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $needsRestart = $UserPath -notlike "*$InstallDir*"
    if ($needsRestart) {
        Write-Host "Adding $InstallDir to PATH..."
        [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    }

    Configure-BashShell

    # An omp earlier on PATH (a previous `bun install -g`, Scoop, ...) keeps
    # winning over this install: $InstallDir is appended to PATH, not prepended.
    $Active = Get-Command omp -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Active -and $Active.Source -ne [System.IO.Path]::GetFullPath($OutPath)) {
        Write-Host "[WARN] 'omp' still resolves to $($Active.Source); remove that install or move $InstallDir ahead of it on PATH." -ForegroundColor Yellow
    }

    if ($needsRestart) {
        Write-Host "Restart your terminal, then run 'omp' to get started!"
    } else {
        Write-Host "Run 'omp' to get started!"
    }
}

function Remove-OmpPath {
    param([string]$Path)
    Write-Host "Removing $Path"
    try {
        Remove-Item -LiteralPath $Path -Recurse -Force
    } catch {
        throw "Could not remove ${Path}: $_`nClose any running omp sessions, then re-run the uninstall."
    }
}

# Remove what an update can leave beside launcher $Path: omp's self-update
# temporaries and backups (<name>.<timestamp>.<pid>[.<seq>].bak|.new|.patch,
# legacy <name>.bak and <name>.new, shims renamed aside by a takeover) and this
# script's .omp.download.exe.
function Remove-UpdateLeftovers {
    param([string]$Path)
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
        return
    }
    $pattern = '^' + [regex]::Escape((Split-Path -Leaf $Path)) + '\.(?:\d+(?:\.\d+)*\.(?:bak|new|patch)|bak|new)$'
    Get-ChildItem -LiteralPath $dir -Force |
        Where-Object { $_.Name -match $pattern -or $_.Name -eq ".omp.download.exe" } |
        ForEach-Object { Remove-OmpPath $_.FullName }
}

# After a package manager removed omp, an omp.exe still in its launcher
# directory is the standalone binary omp's self-update installed there.
function Remove-TakenOverLauncher {
    param([string]$Dir)
    $exe = Join-Path $Dir "omp.exe"
    if (Test-Path -LiteralPath $exe -PathType Leaf) {
        Remove-OmpPath $exe
    }
    foreach ($name in @("omp.exe", "omp", "omp.cmd", "omp.ps1", "omp.bat")) {
        Remove-UpdateLeftovers (Join-Path $Dir $name)
    }
}

function Remove-UserPathEntry {
    param([string]$Dir)
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $userPath) {
        return
    }
    $target = $Dir.TrimEnd("\")
    $entries = $userPath -split ";"
    $kept = @($entries | Where-Object { $_.TrimEnd("\") -ne $target })
    if ($kept.Count -eq $entries.Count) {
        return
    }
    Write-Host "Removing $Dir from your user PATH"
    [Environment]::SetEnvironmentVariable("Path", ($kept -join ";"), "User")
}

# Remove the binary this script installs. The installer also creates
# $InstallDir and adds it to the user PATH; once nothing else lives there,
# undo both. Returns whether omp.exe was there.
function Uninstall-Binary {
    $exe = Join-Path $InstallDir "omp.exe"
    $found = Test-Path -LiteralPath $exe
    if ($found) {
        Remove-OmpPath $exe
    }
    Remove-UpdateLeftovers $exe
    if ((Test-Path -LiteralPath $InstallDir -PathType Container) -and
        -not (Get-ChildItem -LiteralPath $InstallDir -Force | Select-Object -First 1)) {
        Remove-OmpPath $InstallDir
    }
    if (-not (Test-Path -LiteralPath $InstallDir)) {
        Remove-UserPathEntry $InstallDir
    }
    return $found
}

# Remove the bun global package (what -Source installs). Returns whether it
# was installed.
function Uninstall-BunPackage {
    $bunRoot = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE ".bun" }
    $globalDir = if ($env:BUN_INSTALL_GLOBAL_DIR) { $env:BUN_INSTALL_GLOBAL_DIR } else { Join-Path $bunRoot "install\global" }
    if (-not (Test-Path -LiteralPath (Join-Path $globalDir "node_modules\$Package"))) {
        return $false
    }
    $bun = Get-Command bun -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $bunPath = if ($bun) { $bun.Source } else { Join-Path $bunRoot "bin\bun.exe" }
    if (-not (Test-Path -LiteralPath $bunPath)) {
        throw "Found $Package in bun's global packages ($globalDir), but bun is not available to remove it"
    }
    Write-Host "Removing the bun global package $Package..."
    Invoke-Native { & $bunPath remove -g $Package | Out-Host }
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to remove $Package with bun"
    }
    $binDir = if ($env:BUN_INSTALL_BIN) { $env:BUN_INSTALL_BIN } else { Join-Path $bunRoot "bin" }
    Remove-TakenOverLauncher $binDir
    return $true
}

# Remove an npm global install of the package. Returns whether there was one.
function Uninstall-NpmPackage {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        return $false
    }
    $npmRoot = Invoke-Native { npm root -g 2>$null } | Select-Object -First 1
    if (-not $npmRoot -or -not (Test-Path -LiteralPath (Join-Path "$npmRoot".Trim() $Package))) {
        return $false
    }
    $npmPrefix = Invoke-Native { npm prefix -g 2>$null } | Select-Object -First 1
    Write-Host "Removing the npm global package $Package..."
    Invoke-Native { npm uninstall -g $Package | Out-Host }
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to remove $Package with npm"
    }
    # npm puts Windows launchers directly in the global prefix.
    if ($npmPrefix) {
        Remove-TakenOverLauncher "$npmPrefix".Trim()
    }
    return $true
}

# Delete omp's state directory with -Purge, or when an interactive user
# confirms; otherwise keep it and say how to delete it.
function Remove-OmpState {
    $dirName = if ($env:PI_CONFIG_DIR) { $env:PI_CONFIG_DIR } else { ".omp" }
    $stateRoot = [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE $dirName))
    if (-not (Test-Path -LiteralPath $stateRoot -PathType Container)) {
        return
    }
    # A PI_CONFIG_DIR of "." or ".." would otherwise name the profile directory
    # or one of its ancestors.
    $sep = [System.IO.Path]::DirectorySeparatorChar
    $homeFull = [System.IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd($sep) + $sep
    if ($homeFull.StartsWith($stateRoot.TrimEnd($sep) + $sep, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to delete omp's state at ${stateRoot}: it contains your profile directory (check PI_CONFIG_DIR)"
    }

    if (-not $Purge) {
        $confirmed = $false
        $nonInteractive = [Environment]::GetCommandLineArgs() | Where-Object { $_ -match '^-noni' }
        if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not $nonInteractive) {
            Write-Host ""
            Write-Host "omp's state is stored in $stateRoot"
            Write-Host "It holds your sessions, settings, credentials, caches and the git"
            Write-Host "worktrees omp created, which may contain uncommitted work."
            $answer = Read-Host "Delete it too? [y/N]"
            $confirmed = $answer -match '^(y|yes)$'
        }
        if (-not $confirmed) {
            Write-Host ""
            Write-Host "Kept omp's state (sessions, settings, credentials, caches, worktrees) in $stateRoot"
            Write-Host "To delete it as well, re-run with -Purge."
            return
        }
    }

    Remove-OmpPath $stateRoot
    Write-Host "[OK] Deleted omp's state" -ForegroundColor Green
}

function Uninstall-Omp {
    $removed = Uninstall-Binary
    if (Uninstall-BunPackage) {
        $removed = $true
    }
    if (Uninstall-NpmPackage) {
        $removed = $true
    }

    if ($removed) {
        Write-Host ""
        Write-Host "[OK] Uninstalled omp" -ForegroundColor Green
    } else {
        Write-Host "No omp install found in $InstallDir or in bun's or npm's global packages."
    }

    $Active = Get-Command omp -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($Active) {
        Write-Host "[WARN] 'omp' still resolves to $($Active.Source), which this script did not install; remove it with the tool that installed it." -ForegroundColor Yellow
    }

    Remove-OmpState
}

if ($Uninstall -or $Purge) {
    if ($Source -or $Binary -or $Ref) {
        throw "-Uninstall and -Purge do not combine with -Source, -Binary or -Ref"
    }
    Uninstall-Omp
    return
}

# Main logic. A ref can name a branch or commit, which only a source install
# can build, so a bare -Ref selects source.
if ($Ref -and -not $Binary) {
    $Source = $true
}

if ($Source) {
    if (-not (Test-BunInstalled)) {
        Install-Bun
    }
    Assert-BunVersion $MinimumBunVersion
    Install-ViaBun
} else {
    Install-Binary
}

param([Parameter(Mandatory)] [ValidateSet('win32-x64','win32-arm64')] [string]$Target)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if ($Target -eq 'win32-arm64') {
    $arch = 'arm64'
    $triple = 'aarch64-pc-windows-msvc'
    $sha = 'c8cd61f6624accf0d0f9f4519ddcc97745c6a865205bb43f364b6aaf9c50a31e'
    $ucrtSha512 = 'L01qxiIcemqi/SvwXKHwfS7qOY7z8F4zRW88uesnfp55xEDY11MMlv+cjtAYCcqDSEDwHx/bGEouLusta218EA=='
} else {
    $arch = 'x64'
    $triple = 'x86_64-pc-windows-msvc'
    $sha = 'c54ac8146b420fe72e11e6fdd56498d6818011ad23267196b6ab37b5ac9264c3'
    $ucrtSha512 = 'UOPLPnlH/Q+FX8l26uR87+wWPSoCQU9SwmoJe80FiAcZLp27kGl9H2D6gv2C7B3R1Wmos06MAzgqRKl134/NJg=='
}
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products '*' -property installationPath
if (!$vs) { throw 'Visual Studio installation not found' }
Import-Module "$vs\Common7\Tools\Microsoft.VisualStudio.DevShell.dll"
Enter-VsDevShell -VsInstallPath $vs -SkipAutomaticLocation -DevCmdArguments "-arch=$arch -host_arch=$arch"

# The full LLVM release includes llvm-objcopy, llvm-nm, lld-link, libclang and
# the builtins, which a preinstalled Visual Studio clang component needn't.
$release = "clang+llvm-23.1.1-$triple"
$scratch = Join-Path $env:GITHUB_WORKSPACE 'target'
$tar = Join-Path $scratch 'llvm.tar.xz'
curl.exe -fsSL --retry 3 -o $tar "https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.1/$release.tar.xz"
if ((Get-FileHash $tar -Algorithm SHA256).Hash -ne $sha) { throw 'LLVM archive sha256 mismatch' }
tar.exe -xf $tar -C $scratch "$release/bin" "$release/lib/clang"
Remove-Item $tar
$env:PATH = "$scratch\$release\bin;$env:PATH"
$env:LLVM_BIN = "$scratch\$release\bin"
$env:LIBCLANG_PATH = $env:LLVM_BIN

# The kits reference the serviced static UCRT used for upstream's final link.
# Extract only its target libraries, not another copy of the Windows SDK.
$pkg = "microsoft.windows.sdk.cpp.$arch"
$version = '10.0.26100.8249'
$overlay = Join-Path $scratch 'ucrt.nupkg'
curl.exe -fsSL --retry 3 -o $overlay "https://api.nuget.org/v3-flatcontainer/$pkg/$version/$pkg.$version.nupkg"
$digest = [Convert]::ToHexString([Convert]::FromBase64String($ucrtSha512))
if ((Get-FileHash $overlay -Algorithm SHA512).Hash -ne $digest) { throw 'Serviced UCRT package sha512 mismatch' }
tar.exe -xf $overlay -C $scratch "c/ucrt/$arch/*"
Remove-Item $overlay
$env:BUN_LINK_KIT_UCRT_LIB = "$scratch\c\ucrt\$arch"
python scripts/linked-natives/build.py $Target

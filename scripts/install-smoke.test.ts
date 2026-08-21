import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function toShellPath(path: string): string {
	const normalized = path.replaceAll("\\", "/");
	if (process.platform !== "win32") return normalized;
	return normalized.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

const INSTALLER_PATH = toShellPath(join(import.meta.dir, "install.sh"));
const SHELL_EXECUTABLE = Bun.which("sh") ?? "sh";
const POWERSHELL_EXECUTABLE = Bun.which("pwsh") ?? Bun.which("powershell.exe");
const powershellTest = POWERSHELL_EXECUTABLE ? test : test.skip;
const DIST_BASE = "https://dist.example.test";
const INSTALLER_HARNESS = `
uname() {
    case "$1" in
        -s) printf '%s\\n' "$MOCK_UNAME_OS" ;;
        -m) printf '%s\\n' "$MOCK_UNAME_ARCH" ;;
        *) return 2 ;;
    esac
}
curl() {
    printf '%s\\n' "$*" >> "$MOCK_CURL_LOG"
    case "$*" in
        *"/version"*) printf '%s\\n' "$MOCK_VERSION" ;;
    esac
}
bun() {
    printf '%s\\n' "$*" >> "$MOCK_BUN_LOG"
    if [ "$1" = "--version" ]; then
        printf '%s\\n' "1.3.14"
    fi
}
mkdir() { return 0; }
chmod() { return 0; }
cp() { return 0; }
tr() {
    IFS= read -r line
    printf '%s' "$line"
}
installer_path="$1"
shift
. "$installer_path"
`;

interface InstallerFixture {
	os: string;
	arch: string;
	args?: string[];
	version?: string;
}

interface InstallerResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	curlCalls: string;
	bunCalls: string;
}

function runInstaller({
	os,
	arch,
	args = ["--binary", "--ref", "fixture-ref"],
	version = "v16.4.6",
}: InstallerFixture): InstallerResult {
	const fixtureDir = mkdtempSync(join(tmpdir(), "ompk-install-smoke-"));
	const curlLog = join(fixtureDir, "curl.log");
	const bunLog = join(fixtureDir, "bun.log");

	try {
		const result = Bun.spawnSync(
			[SHELL_EXECUTABLE, "-c", INSTALLER_HARNESS, "installer-smoke", INSTALLER_PATH, ...args],
			{
				cwd: import.meta.dir,
				env: {
					...process.env,
					MOCK_UNAME_OS: os,
					MOCK_UNAME_ARCH: arch,
					MOCK_VERSION: version,
					MOCK_CURL_LOG: toShellPath(curlLog),
					MOCK_BUN_LOG: toShellPath(bunLog),
					OMP_DIST_BASE: DIST_BASE,
					PI_INSTALL_DIR: toShellPath(join(fixtureDir, "install")),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);

		return {
			exitCode: result.exitCode,
			stdout: new TextDecoder().decode(result.stdout),
			stderr: new TextDecoder().decode(result.stderr),
			curlCalls: existsSync(curlLog) ? readFileSync(curlLog, "utf8") : "",
			bunCalls: existsSync(bunLog) ? readFileSync(bunLog, "utf8") : "",
		};
	} finally {
		rmSync(fixtureDir, { recursive: true, force: true });
	}
}
const POWERSHELL_HARNESS = String.raw`
$ErrorActionPreference = "Stop"
$installerPath = $env:MOCK_INSTALLER_PATH
$script:HarnessArchitecture = $env:MOCK_WINDOWS_ARCH
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    $installerPath,
    [ref]$tokens,
    [ref]$parseErrors
)
if ($parseErrors.Count -ne 0) {
    throw "Installer parse failed: $($parseErrors[0].Message)"
}
$functionDefinitions = $ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $true)
foreach ($definition in $functionDefinitions) {
    Invoke-Expression $definition.Extent.Text
}

function Get-WindowsOsArchitecture {
    return $script:HarnessArchitecture
}

$script:NetworkCalls = 0
$script:DownloadUrl = ""
$Ref = "v16.4.6"
$DistBase = "https://dist.example.test"
$BinaryName = "omp-windows-x64.exe"
$InstallDir = "C:\unused-installer-smoke"

function Invoke-RestMethod {
    $script:NetworkCalls += 1
    return "v16.4.6"
}

function Invoke-WebRequest {
    param($Uri, $OutFile)
    $script:NetworkCalls += 1
    $script:DownloadUrl = $Uri
    throw "__download_captured__"
}

if ($script:HarnessArchitecture -eq "X64") {
    try {
        Install-Binary
        throw "__download_not_attempted__"
    } catch {
        if ($_.Exception.Message -ne "__download_captured__") {
            throw
        }
    }
    if ($script:NetworkCalls -ne 1) {
        throw "Expected one download, got $script:NetworkCalls network calls"
    }
    if ($script:DownloadUrl -ne "https://dist.example.test/bin/v16.4.6/omp-windows-x64.exe") {
        throw "Unexpected download URL: $script:DownloadUrl"
    }
    Write-Output "download=$script:DownloadUrl"
    exit 0
}

try {
    Install-Binary
    throw "__unsupported_architecture_accepted__"
} catch {
    if ($_.Exception.Message -notlike "*Unsupported architecture: ARM64*") {
        throw
    }
}
if ($script:NetworkCalls -ne 0) {
    throw "Unsupported architecture made $script:NetworkCalls network calls"
}
Write-Output "rejected=ARM64 network=0"
`;

function runPowerShellInstallerHarness(architecture: "X64" | "ARM64"): InstallerResult {
	if (!POWERSHELL_EXECUTABLE) {
		throw new Error("PowerShell is required for the Windows installer smoke tests");
	}
	const result = Bun.spawnSync(
		[POWERSHELL_EXECUTABLE, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_HARNESS],
		{
			cwd: import.meta.dir,
			env: {
				...process.env,
				MOCK_INSTALLER_PATH: join(import.meta.dir, "install.ps1"),
				MOCK_WINDOWS_ARCH: architecture,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return {
		exitCode: result.exitCode,
		stdout: new TextDecoder().decode(result.stdout),
		stderr: new TextDecoder().decode(result.stderr),
		curlCalls: "",
		bunCalls: "",
	};
}

powershellTest(
	"install.ps1 downloads the Windows x64 binary for an x64 OS",
	() => {
		const result = runPowerShellInstallerHarness("X64");

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("download=https://dist.example.test/bin/v16.4.6/omp-windows-x64.exe");
	},
	30_000,
);

powershellTest(
	"install.ps1 rejects Windows ARM64 before any network call",
	() => {
		const result = runPowerShellInstallerHarness("ARM64");

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("rejected=ARM64 network=0");
	},
	30_000,
);

describe("install.sh", () => {
	test("keeps npm through Bun as the default install mode", () => {
		const result = runInstaller({ os: "Linux", arch: "x86_64", args: [] });

		expect(result.exitCode).toBe(0);
		expect(result.bunCalls).toContain("install -g @pk-nerdsaver-ai/pi-coding-agent");
		expect(result.curlCalls).toBe("");
	});

	const supportedTargets = [
		["Darwin", "arm64", "omp-darwin-arm64"],
		["Darwin", "x86_64", "omp-darwin-x64"],
		["Linux", "aarch64", "omp-linux-arm64"],
		["Linux", "x86_64", "omp-linux-x64"],
	] as const;

	for (const [os, arch, filename] of supportedTargets) {
		test(`downloads ${filename} for ${os} ${arch}`, () => {
			const result = runInstaller({ os, arch });

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toContain(`Downloading ${filename}...`);
			expect(result.curlCalls).toContain(`${DIST_BASE}/bin/fixture-ref/${filename}`);
		});
	}

	test("preserves a v-prefixed version in the download URL", () => {
		const result = runInstaller({ os: "Darwin", arch: "arm64", args: ["--binary"], version: "v16.4.6" });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Using version: v16.4.6");
		expect(result.curlCalls).toContain(`${DIST_BASE}/bin/v16.4.6/omp-darwin-arm64`);
	});

	test("rejects an unsupported OS before downloading", () => {
		const result = runInstaller({ os: "FreeBSD", arch: "x86_64" });

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("Unsupported OS: FreeBSD");
		expect(result.curlCalls).toBe("");
	});

	test("rejects an unsupported architecture before downloading", () => {
		const result = runInstaller({ os: "Linux", arch: "riscv64" });

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("Unsupported architecture: riscv64");
		expect(result.curlCalls).toBe("");
	});
});

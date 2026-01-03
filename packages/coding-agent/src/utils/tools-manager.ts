import { chmodSync, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { APP_NAME, getToolsDir } from "../config";

const TOOLS_DIR = getToolsDir();

interface ToolConfig {
	name: string;
	repo: string; // GitHub repo (e.g., "sharkdp/fd")
	binaryName: string; // Name of the binary inside the archive
	tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
	fd: {
		name: "fd",
		repo: "sharkdp/fd",
		binaryName: "fd",
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-unknown-linux-gnu.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `fd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	rg: {
		name: "ripgrep",
		repo: "BurntSushi/ripgrep",
		binaryName: "rg",
		tagPrefix: "",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				if (architecture === "arm64") {
					return `ripgrep-${version}-aarch64-unknown-linux-gnu.tar.gz`;
				}
				return `ripgrep-${version}-x86_64-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ripgrep-${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	sd: {
		name: "sd",
		repo: "chmln/sd",
		binaryName: "sd",
		tagPrefix: "v",
		getAssetName: (version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `sd-v${version}-${archStr}-apple-darwin.tar.gz`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `sd-v${version}-${archStr}-unknown-linux-musl.tar.gz`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `sd-v${version}-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
	sg: {
		name: "ast-grep",
		repo: "ast-grep/ast-grep",
		binaryName: "sg",
		tagPrefix: "",
		getAssetName: (_version, plat, architecture) => {
			if (plat === "darwin") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ast-grep-${archStr}-apple-darwin.zip`;
			} else if (plat === "linux") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ast-grep-${archStr}-unknown-linux-gnu.zip`;
			} else if (plat === "win32") {
				const archStr = architecture === "arm64" ? "aarch64" : "x86_64";
				return `ast-grep-${archStr}-pc-windows-msvc.zip`;
			}
			return null;
		},
	},
};

// Check if a command exists in PATH
function commandExists(cmd: string): string | null {
	return Bun.which(cmd);
}

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: "fd" | "rg" | "sd" | "sg"): string | null {
	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const localPath = join(TOOLS_DIR, config.binaryName + (platform() === "win32" ? ".exe" : ""));
	if (existsSync(localPath)) {
		return localPath;
	}

	// Check system PATH
	return commandExists(config.binaryName);
}

// Fetch latest release version from GitHub
async function getLatestVersion(repo: string): Promise<string> {
	const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
		headers: { "User-Agent": `${APP_NAME}-coding-agent` },
	});

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status}`);
	}

	const data = (await response.json()) as { tag_name: string };
	return data.tag_name.replace(/^v/, "");
}

// Download a file from URL
async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetch(url);

	if (!response.ok) {
		throw new Error(`Failed to download: ${response.status}`);
	}

	if (!response.body) {
		throw new Error("No response body");
	}

	const fileStream = createWriteStream(dest);
	const reader = response.body.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		fileStream.write(Buffer.from(value));
	}
	fileStream.end();
	await new Promise<void>((resolve, reject) => {
		fileStream.on("finish", resolve);
		fileStream.on("error", reject);
	});
}

// Download and install a tool
async function downloadTool(tool: "fd" | "rg" | "sd" | "sg"): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = platform();
	const architecture = arch();

	// Get latest version
	const version = await getLatestVersion(config.repo);

	// Get asset name for this platform
	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	// Create tools directory
	mkdirSync(TOOLS_DIR, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const archivePath = join(TOOLS_DIR, assetName);
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = join(TOOLS_DIR, config.binaryName + binaryExt);

	// Download
	await downloadFile(downloadUrl, archivePath);

	// Extract
	const extractDir = join(TOOLS_DIR, "extract_tmp");
	mkdirSync(extractDir, { recursive: true });

	try {
		if (assetName.endsWith(".tar.gz")) {
			Bun.spawnSync(["tar", "xzf", archivePath, "-C", extractDir], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
		} else if (assetName.endsWith(".zip")) {
			Bun.spawnSync(["unzip", "-o", archivePath, "-d", extractDir], {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
		}

		// Find the binary in extracted files
		// ast-grep releases the binary directly in the zip, not in a subdirectory
		let extractedBinary: string;
		if (tool === "sg") {
			extractedBinary = join(extractDir, config.binaryName + binaryExt);
		} else {
			const extractedDir = join(extractDir, assetName.replace(/\.(tar\.gz|zip)$/, ""));
			extractedBinary = join(extractedDir, config.binaryName + binaryExt);
		}

		if (existsSync(extractedBinary)) {
			renameSync(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: ${extractedBinary}`);
		}

		// Make executable (Unix only)
		if (plat !== "win32") {
			chmodSync(binaryPath, 0o755);
		}
	} finally {
		// Cleanup
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

// Ensure a tool is available, downloading if necessary
// Returns the path to the tool, or null if unavailable
export async function ensureTool(
	tool: "fd" | "rg" | "sd" | "sg",
	silent: boolean = false,
): Promise<string | undefined> {
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	// Tool not found - download it
	if (!silent) {
		console.log(chalk.dim(`${config.name} not found. Downloading...`));
	}

	try {
		const path = await downloadTool(tool);
		if (!silent) {
			console.log(chalk.dim(`${config.name} installed to ${path}`));
		}
		return path;
	} catch (e) {
		if (!silent) {
			console.log(chalk.yellow(`Failed to download ${config.name}: ${e instanceof Error ? e.message : e}`));
		}
		return undefined;
	}
}

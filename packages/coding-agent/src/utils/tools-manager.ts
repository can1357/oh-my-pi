import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $which, getToolsDir, logger, ptree, TempDir, USER_AGENT } from "@oh-my-pi/pi-utils";
import { extractArchive } from "@oh-my-pi/pi-utils/ar";

const TOOLS_DIR = getToolsDir();
const TOOL_DOWNLOAD_TIMEOUT_MS = 120_000;
const TOOL_METADATA_TIMEOUT_MS = 5000;

type BodyReadResult = Bun.ReadableStreamDefaultReadResult<Uint8Array>;
type BodyReader = {
	read(): Promise<BodyReadResult>;
	cancel(reason?: unknown): Promise<void>;
};

function isAbortLikeError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function readBodyChunk(reader: BodyReader, signal: AbortSignal | undefined): Promise<BodyReadResult> {
	if (!signal) return await reader.read();
	if (signal.aborted) throw abortReason(signal);

	const abort = Promise.withResolvers<BodyReadResult>();
	const onAbort = () => abort.reject(abortReason(signal));
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([reader.read(), abort.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function writeResponseBody(
	dest: string,
	body: NonNullable<Response["body"]>,
	signal?: AbortSignal,
): Promise<void> {
	const reader = body.getReader();
	const sink = Bun.file(dest).writer();
	let completed = false;

	try {
		while (true) {
			const { done, value } = await readBodyChunk(reader, signal);
			if (done) break;
			if (value) {
				await sink.write(value);
			}
		}
		await sink.end();
		completed = true;
	} finally {
		if (!completed) {
			await reader.cancel().catch(() => {});
			await Promise.resolve(sink.end()).catch(() => {});
			await fs.promises.rm(dest, { force: true }).catch(() => {});
		}
	}
}

interface ToolConfig {
	name: string;
	repo: string; // GitHub repo (e.g., "sharkdp/fd")
	binaryName: string; // Name of the binary inside the archive
	tagPrefix: string; // Prefix for tags (e.g., "v" for v1.0.0, "" for 1.0.0)
	isDirectBinary?: boolean; // If true, asset is a direct binary (not an archive)
	getAssetName: (version: string, plat: string, architecture: string) => string | null;
}

const TOOLS: Record<string, ToolConfig> = {
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
	"yt-dlp": {
		name: "yt-dlp",
		repo: "yt-dlp/yt-dlp",
		binaryName: "yt-dlp",
		tagPrefix: "",
		isDirectBinary: true,
		getAssetName: (_version, plat, architecture) => {
			if (plat === "darwin") {
				return "yt-dlp_macos"; // Universal binary
			} else if (plat === "linux") {
				return architecture === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
			} else if (plat === "win32") {
				return architecture === "arm64" ? "yt-dlp_arm64.exe" : "yt-dlp.exe";
			}
			return null;
		},
	},
};

// CLI packages installed via uv/pip
interface PythonPackageToolConfig {
	name: string;
	package: string; // PyPI package name
	binaryName: string; // CLI command name after install
}

const PYTHON_TOOLS: Record<string, PythonPackageToolConfig> = {
	trafilatura: {
		name: "trafilatura",
		package: "trafilatura",
		binaryName: "trafilatura",
	},
};

export type ToolName = "sd" | "sg" | "yt-dlp" | "trafilatura";

// Get the path to a tool (system-wide or in our tools dir)
export function getToolPath(tool: ToolName): string | null {
	// Check uv/pip-installed CLI packages first
	const pythonConfig = PYTHON_TOOLS[tool];
	if (pythonConfig) {
		return $which(pythonConfig.binaryName);
	}

	const config = TOOLS[tool];
	if (!config) return null;

	// Check our tools directory first
	const localPath = path.join(TOOLS_DIR, config.binaryName + (os.platform() === "win32" ? ".exe" : ""));
	if (fs.existsSync(localPath)) {
		return localPath;
	}

	// Check system PATH
	return $which(config.binaryName);
}

// Fetch latest release version from GitHub
async function getLatestVersion(repo: string, signal?: AbortSignal): Promise<string> {
	let response: Response;
	try {
		response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
			headers: { "User-Agent": USER_AGENT },
			signal: ptree.combineSignals(signal, TOOL_METADATA_TIMEOUT_MS),
		});
	} catch (err) {
		if (err instanceof Error && err.name === "AbortError") {
			throw new Error("GitHub API request timed out");
		}
		throw err;
	}

	if (!response.ok) {
		throw new Error(`GitHub API error: ${response.status}`);
	}

	const data = (await response.json()) as { tag_name: string };
	return data.tag_name.replace(/^v/, "");
}

/** Download a tool asset without handing the streaming Response to Bun.write. */
export async function downloadFile(url: string, dest: string, signal?: AbortSignal): Promise<void> {
	const downloadSignal = ptree.combineSignals(signal, TOOL_DOWNLOAD_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetch(url, {
			signal: downloadSignal,
		});
		if (!response.ok) {
			throw new Error(`Failed to download: ${response.status}`);
		} else if (!response.body) {
			throw new Error("No response body");
		}
		await writeResponseBody(dest, response.body, downloadSignal);
	} catch (err) {
		if (isAbortLikeError(err)) {
			throw new Error(`Download timed out: ${url}`);
		}
		throw err;
	}
}

// Download and install a tool
async function downloadTool(tool: ToolName, signal?: AbortSignal): Promise<string> {
	const config = TOOLS[tool];
	if (!config) throw new Error(`Unknown tool: ${tool}`);

	const plat = os.platform();
	const architecture = os.arch();

	// Get latest version
	const version = await getLatestVersion(config.repo, signal);

	// Get asset name for this platform
	const assetName = config.getAssetName(version, plat, architecture);
	if (!assetName) {
		throw new Error(`Unsupported platform: ${plat}/${architecture}`);
	}

	// Create tools directory
	await fs.promises.mkdir(TOOLS_DIR, { recursive: true });

	const downloadUrl = `https://github.com/${config.repo}/releases/download/${config.tagPrefix}${version}/${assetName}`;
	const binaryExt = plat === "win32" ? ".exe" : "";
	const binaryPath = path.join(TOOLS_DIR, config.binaryName + binaryExt);

	// Handle direct binary downloads (no archive extraction needed)
	if (config.isDirectBinary) {
		await downloadFile(downloadUrl, binaryPath, signal);
		if (plat !== "win32") {
			await fs.promises.chmod(binaryPath, 0o755);
		}
		return binaryPath;
	}

	// Download archive
	const archivePath = path.join(TOOLS_DIR, assetName);
	await downloadFile(downloadUrl, archivePath, signal);

	// Extract
	const tmp = await TempDir.create("@omp-tools-extract-");

	try {
		if (!assetName.endsWith(".tar.gz") && !assetName.endsWith(".zip")) {
			throw new Error(`Unsupported archive format: ${assetName}`);
		}

		try {
			await extractArchive(archivePath, tmp.path());
		} catch (err) {
			throw new Error(`Failed to extract ${assetName}: ${err instanceof Error ? err.message : String(err)}`);
		}

		// Find the binary in extracted files
		// ast-grep releases the binary directly in the zip, not in a subdirectory
		let extractedBinary: string;
		if (tool === "sg") {
			extractedBinary = path.join(tmp.path(), config.binaryName + binaryExt);
		} else {
			const extractedDir = path.join(tmp.path(), assetName.replace(/\.(tar\.gz|zip)$/, ""));
			extractedBinary = path.join(extractedDir, config.binaryName + binaryExt);
		}

		if (fs.existsSync(extractedBinary)) {
			await fs.promises.rename(extractedBinary, binaryPath);
		} else {
			throw new Error(`Binary not found in archive: ${extractedBinary}`);
		}

		// Make executable (Unix only)
		if (plat !== "win32") {
			await fs.promises.chmod(binaryPath, 0o755);
		}
	} finally {
		// Cleanup
		await tmp.remove();
		await fs.promises.rm(archivePath, { force: true });
	}

	return binaryPath;
}

// Install a Python package via uv (preferred) or pip
async function installPythonPackage(pkg: string, signal?: AbortSignal): Promise<boolean> {
	try {
		// Try uv first (faster, better isolation)
		const uv = $which("uv");
		if (uv) {
			const result = await ptree.exec([uv, "tool", "install", pkg], {
				signal,
				allowNonZero: true,
				allowAbort: true,
				stderr: "full",
			});
			if (result.exitCode === 0) return true;
		}

		// Fall back to pip
		const pip = $which("pip3") || $which("pip");
		if (pip) {
			const result = await ptree.exec([pip, "install", "--user", pkg], {
				signal,
				allowNonZero: true,
				allowAbort: true,
				stderr: "full",
			});
			return result.exitCode === 0;
		}

		return false;
	} catch (error) {
		logger.warn(`Failed to install Python package ${pkg}`, {
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

// Termux package names for tools
const TERMUX_PACKAGES: Partial<Record<ToolName, string>> = {
	sd: "sd",
	sg: "ast-grep",
};

// Ensure a tool is available, downloading if necessary
// Returns the path to the tool, or null if unavailable
type EnsureToolOptions = {
	signal?: AbortSignal;
	silent?: boolean;
	notify?: (message: string) => void;
};

export async function ensureTool(tool: ToolName, silentOrOptions?: EnsureToolOptions): Promise<string | undefined> {
	const { signal, silent = false, notify } = silentOrOptions ?? {};
	const existingPath = getToolPath(tool);
	if (existingPath) {
		return existingPath;
	}

	// On Android/Termux, Linux binaries don't work due to Bionic libc incompatibility.
	// Users must install via pkg.
	if (os.platform() === "android") {
		const pkgName = TERMUX_PACKAGES[tool] ?? tool;
		if (!silent) {
			logger.warn(`${TOOLS[tool]?.name ?? tool} not found. Install with: pkg install ${pkgName}`);
		}
		return undefined;
	}

	// Handle uv/pip-installed CLI packages
	const pythonConfig = PYTHON_TOOLS[tool];
	if (pythonConfig) {
		if (!silent) {
			logger.debug(`${pythonConfig.name} not found. Installing via uv/pip...`);
		}
		notify?.(`Installing ${pythonConfig.name}…`);
		const success = await installPythonPackage(pythonConfig.package, signal);
		if (success) {
			// Re-check for the command after installation
			const path = $which(pythonConfig.binaryName);
			if (path) {
				if (!silent) {
					logger.debug(`${pythonConfig.name} installed successfully`);
				}
				return path;
			}
		}
		if (!silent) {
			logger.warn(`Failed to install ${pythonConfig.name}`);
		}
		return undefined;
	}

	const config = TOOLS[tool];
	if (!config) return undefined;

	// Tool not found - download it
	if (!silent) {
		logger.debug(`${config.name} not found. Downloading...`);
	}
	notify?.(`Downloading ${config.name}…`);

	try {
		const path = await downloadTool(tool, signal);
		if (!silent) {
			logger.debug(`${config.name} installed to ${path}`);
		}
		return path;
	} catch (e) {
		if (!silent) {
			logger.warn(`Failed to download ${config.name}`, {
				error: e instanceof Error ? e.message : String(e),
			});
		}
		return undefined;
	}
}

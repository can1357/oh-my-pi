/**
 * Local Binary Ninja install detection used by disassembler backend selection.
 *
 * Detection is synchronous because tool gating and prompt rendering are synchronous; it runs
 * once per settings input change (memoized by the registry), never per call.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env, logger } from "@oh-my-pi/pi-utils";
import { cfgBinjaInstallDir } from "./settings";

/** Everything install discovery reads from the machine besides the filesystem. */
export interface BinjaHost {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	home: string;
}

/**
 * Directory holding the core library for `candidate`, which is either that directory or, on
 * macOS, the `.app` bundle around it.
 */
function coreDir(candidate: string, platform: NodeJS.Platform): string | undefined {
	const library =
		platform === "darwin"
			? "libbinaryninjacore.dylib"
			: platform === "win32"
				? "binaryninjacore.dll"
				: "libbinaryninjacore.so.1";
	if (fs.existsSync(path.join(candidate, library))) return candidate;
	if (platform === "darwin") {
		const bundled = path.join(candidate, "Contents", "MacOS");
		if (fs.existsSync(path.join(bundled, library))) return bundled;
	}
	return undefined;
}

/** Binary Ninja's user folder: `$BN_USER_DIRECTORY`, else the per-platform default. */
function userDir(host: BinjaHost): string {
	const override = host.env.BN_USER_DIRECTORY;
	if (override) return override;
	switch (host.platform) {
		case "darwin":
			return path.join(host.home, "Library", "Application Support", "Binary Ninja");
		case "win32":
			return path.join(host.env.APPDATA ?? path.join(host.home, "AppData", "Roaming"), "Binary Ninja");
		default:
			return path.join(host.home, ".binaryninja");
	}
}

/** Install directory the UI recorded in the user folder's one-line `lastrun` file. */
function lastRunDir(host: BinjaHost): string | undefined {
	try {
		return fs.readFileSync(path.join(userDir(host), "lastrun"), "utf8").trim() || undefined;
	} catch {
		// No UI run recorded: headless runs do not write the file.
		return undefined;
	}
}

/** Vendor default install locations per platform. */
function defaultInstallDirs(host: BinjaHost): string[] {
	switch (host.platform) {
		case "darwin":
			return ["/Applications/Binary Ninja.app", path.join(host.home, "Applications", "Binary Ninja.app")];
		case "win32": {
			const localAppData = host.env.LOCALAPPDATA ?? path.join(host.home, "AppData", "Local");
			return [
				path.join(host.env.ProgramFiles ?? "C:\\Program Files", "Vector35", "BinaryNinja"),
				path.join(localAppData, "Vector35", "BinaryNinja"),
				path.join(localAppData, "Programs", "Vector35", "BinaryNinja"),
			];
		}
		default:
			return [path.join(host.home, "binaryninja")];
	}
}

/**
 * Directory containing the Binary Ninja core library, or undefined when no install exists.
 * An explicit `configured` directory is authoritative: when it holds no core library, nothing
 * else is tried. Otherwise checks `$BN_INSTALL_DIR`, the `lastrun` file, then the vendor default
 * locations. Every candidate may be the macOS `.app` bundle instead of the library directory.
 */
export function locateBinjaInstall(
	configured: string | undefined,
	host: BinjaHost = { platform: process.platform, env: $env, home: os.homedir() },
): string | undefined {
	if (configured) {
		const dir = coreDir(configured, host.platform);
		if (!dir) {
			logger.warn("binja.installDir has no Binary Ninja core library; Binary Ninja features stay hidden", {
				installDir: configured,
			});
		}
		return dir;
	}
	const candidates = [host.env.BN_INSTALL_DIR, lastRunDir(host), ...defaultInstallDirs(host)];
	for (const candidate of candidates) {
		const dir = candidate ? coreDir(candidate, host.platform) : undefined;
		if (dir) return dir;
	}
	return undefined;
}

/**
 * Directory of the Python API for the install whose core library sits in `installDir`: the one
 * to put on `PYTHONPATH`.
 */
export function binjaPythonDir(installDir: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "darwin"
		? path.join(path.dirname(installDir), "Resources", "python")
		: path.join(installDir, "python");
}

/** Installed Binary Ninja core-library directory, independent of backend selection. */
export const cfgBinjaInstall = cfgBinjaInstallDir.map(dir => locateBinjaInstall(dir?.trim() || undefined));

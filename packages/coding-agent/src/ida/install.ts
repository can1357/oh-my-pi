/**
 * Local IDA Pro install detection. IDA features (`read` views, the `ida` tool) are only
 * exposed when {@link cfgIdaAvailable} finds an install shipping idalib.
 *
 * Detection is synchronous because tool gating and prompt rendering are synchronous; it runs
 * once per settings input change (memoized by the registry), never per call.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env, logger } from "@oh-my-pi/pi-utils";
import { combine } from "../config/registry";
import { cfgIdaEnabled, cfgIdaInstallDir } from "./settings";

const IDALIB =
	process.platform === "darwin" ? "libidalib.dylib" : process.platform === "win32" ? "idalib.dll" : "libidalib.so";

function hasIdalib(dir: string): boolean {
	return fs.existsSync(path.join(dir, IDALIB));
}

/** `Paths.ida-install-dir` from each `ida-config.json` idalib itself would consult, in order. */
function configuredInstallDirs(): string[] {
	const userDirs = ($env.IDAUSR ?? "").split(path.delimiter).filter(Boolean);
	userDirs.push(
		process.platform === "win32"
			? path.join($env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Hex-Rays", "IDA Pro")
			: path.join(os.homedir(), ".idapro"),
	);
	const dirs: string[] = [];
	for (const userDir of userDirs) {
		try {
			const config: { Paths?: { "ida-install-dir"?: unknown } } = JSON.parse(
				fs.readFileSync(path.join(userDir, "ida-config.json"), "utf8"),
			);
			const dir = config.Paths?.["ida-install-dir"];
			if (typeof dir === "string" && dir) dirs.push(dir);
		} catch {
			// Missing or malformed config: idalib ignores it too.
		}
	}
	return dirs;
}

/** Children of `parent` whose names start with `prefix` (case-insensitive), newest version first. */
function childDirs(parent: string, prefix: string, suffix = ""): string[] {
	let names: string[];
	try {
		names = fs.readdirSync(parent);
	} catch {
		return [];
	}
	return names
		.filter(name => name.toLowerCase().startsWith(prefix))
		.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
		.map(name => path.join(parent, name, suffix));
}

/** Standard install locations per platform. */
function defaultInstallDirs(): string[] {
	switch (process.platform) {
		case "darwin":
			return [
				...childDirs("/Applications", "ida", "Contents/MacOS"),
				...childDirs(path.join(os.homedir(), "Applications"), "ida", "Contents/MacOS"),
			];
		case "win32":
			return childDirs($env.ProgramFiles ?? "C:\\Program Files", "ida");
		default:
			return [...childDirs(os.homedir(), "ida"), ...childDirs("/opt", "ida")];
	}
}

/**
 * Directory of a local IDA install that ships idalib, or undefined when none exists.
 * An explicit `configured` directory is authoritative: when it lacks idalib, nothing else is tried.
 * Otherwise checks `$IDADIR`, `ida-config.json`, then standard install locations.
 */
export function locateIdaInstall(configured: string | undefined): string | undefined {
	if (configured) {
		if (hasIdalib(configured)) return configured;
		logger.warn("ida.installDir has no idalib; IDA features stay hidden", { installDir: configured });
		return undefined;
	}
	const candidates = [$env.IDADIR, ...configuredInstallDirs(), ...defaultInstallDirs()];
	return candidates.find((dir): dir is string => !!dir && hasIdalib(dir));
}

/** IDA install directory when `ida.enabled` is on and an install is found; undefined otherwise. */
export const cfgIdaInstall = combine(
	{ enabled: cfgIdaEnabled, installDir: cfgIdaInstallDir },
	({ enabled, installDir }) => (enabled ? locateIdaInstall(installDir?.trim() || undefined) : undefined),
);

/** Whether IDA features (`read` views, the `ida` tool) are exposed. */
export const cfgIdaAvailable = cfgIdaInstall.map(dir => dir !== undefined);

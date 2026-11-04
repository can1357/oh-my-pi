import * as os from "node:os";
import * as path from "node:path";

const WINDOWS_DRIVE_PATH = /^([A-Za-z]):[\\/](.*)$/;

/** Maps an absolute Windows drive path to the drive's default WSL mount. */
export function windowsPathToWslMount(filePath: string): string | undefined {
	const normalized = path.win32.normalize(filePath.trim());
	const match = WINDOWS_DRIVE_PATH.exec(normalized);
	if (!match) return undefined;
	const [, drive, rest] = match;
	const segments = rest.split("\\").filter(Boolean);
	return path.posix.join("/mnt", drive!.toLowerCase(), ...segments);
}

const WINDOWS_DRIVE_EXTENDED_PREFIX = /^\\\\[?]\\([A-Za-z]:[\\/].*)$/;
const WINDOWS_UNC_EXTENDED_PREFIX = /^\\\\[?]\\UNC[\\/]([^\\/]+)[\\/](.+)$/i;
const WINDOWS_DRIVE_EXTENDED_FORWARD_PREFIX = /^\/\/[?]\/([A-Za-z]:\/.*)$/;
const WINDOWS_UNC_EXTENDED_FORWARD_PREFIX = /^\/\/[?]\/UNC\/([^/]+)\/(.+)$/i;
const WINDOWS_DRIVE_NT_PREFIX = /^\\\\[?][?]\\([A-Za-z]:[\\/].*)$/;
const WINDOWS_UNC_NT_PREFIX = /^\\\\[?][?]\\UNC[\\/]([^\\/]+)[\\/](.+)$/i;

/** Removes Win32 extended-length prefixes before passing paths to Bun APIs. */
export function stripWindowsExtendedLengthPathPrefix(
	filePath: string,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform !== "win32") return filePath;

	const uncMatch = WINDOWS_UNC_EXTENDED_PREFIX.exec(filePath) ?? WINDOWS_UNC_NT_PREFIX.exec(filePath);
	if (uncMatch) return `\\\\${uncMatch[1]}\\${uncMatch[2]}`;

	const driveMatch = WINDOWS_DRIVE_EXTENDED_PREFIX.exec(filePath) ?? WINDOWS_DRIVE_NT_PREFIX.exec(filePath);
	if (driveMatch) return driveMatch[1];

	const forwardUncMatch = WINDOWS_UNC_EXTENDED_FORWARD_PREFIX.exec(filePath);
	if (forwardUncMatch) return `//${forwardUncMatch[1]}/${forwardUncMatch[2]}`;

	const forwardDriveMatch = WINDOWS_DRIVE_EXTENDED_FORWARD_PREFIX.exec(filePath);
	if (forwardDriveMatch) return forwardDriveMatch[1];

	return filePath;
}

/**
 * Test whether a path is fully qualified and drive-independent.
 * On Windows, requires a drive letter with separator (e.g. `C:\`) or UNC (`\\server\share` or `//server/share`).
 * On POSIX, requires an absolute path.
 */
export function isFullyQualifiedPath(filePath: string, platform: NodeJS.Platform = process.platform): boolean {
	const p = platform === "win32" ? path.win32 : path.posix;
	if (!p.isAbsolute(filePath)) return false;
	if (platform === "win32") {
		return /^[a-zA-Z]:[/\\]/.test(filePath) || /^[\\/]{2}[^\\/]/.test(filePath);
	}
	return true;
}

/**
 * The user's home directory. Paths rooted at home MUST resolve it here, not via
 * `os.homedir()`.
 *
 * Bun reads the home once per process and keeps it, so a `HOME` (`USERPROFILE`
 * on Windows) set later (a test's temp home, a worker started after a parent
 * changed `HOME`) never reaches `os.homedir()`; this reads the variable itself.
 * Order:
 * 1. `os.homedir()` while it is a test double (`spyOn` / `vi.spyOn` from
 *    `bun:test`, which carry a `mock` record). The check is on the function
 *    itself, so a spy installed before this module loaded stops winning once it
 *    is restored.
 * 2. `HOME` when set and non-empty.
 * 3. `os.homedir()` (the start-up `HOME`, else the passwd entry). An unset or
 *    empty variable lands here, never on a path relative to the cwd.
 * With the start-up environment unchanged and no spy, every step returns what
 * `os.homedir()` returns.
 */
export function getHomeDir(): string {
	const home = os.homedir();
	if (typeof Reflect.get(os.homedir, "mock") === "object") return home;
	return (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) || home;
}

/** Expands a leading `~` (`~`, `~/…`, `~\…`, `~name`) to `home`, the user's home directory by default. */
export function expandTilde(filePath: string, home?: string): string {
	const h = home ?? getHomeDir();
	if (filePath === "~") return h;
	if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
		return h + filePath.slice(1);
	}
	if (filePath.startsWith("~")) {
		return path.join(h, filePath.slice(1));
	}
	return filePath;
}

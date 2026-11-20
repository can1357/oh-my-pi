/**
 * Chromium browsers on this machine and their profiles, read from their user data directories without touching them:
 * where omp registers its native messaging host, and whether a profile already loads an omp install folder.
 */
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";

/** Chromium browsers omp supports, with each platform's user data directory relative to its base. */
const BROWSERS = [
	{
		name: "Google Chrome",
		darwin: "Google/Chrome",
		linux: "google-chrome",
		win32: "Google/Chrome/User Data",
	},
	{
		name: "Google Chrome Beta",
		darwin: "Google/Chrome Beta",
		linux: "google-chrome-beta",
		win32: "Google/Chrome Beta/User Data",
	},
	{
		name: "Google Chrome Dev",
		darwin: "Google/Chrome Dev",
		linux: "google-chrome-unstable",
		win32: "Google/Chrome Dev/User Data",
	},
	{
		name: "Google Chrome Canary",
		darwin: "Google/Chrome Canary",
		linux: "google-chrome-canary",
		win32: "Google/Chrome SxS/User Data",
	},
	{
		name: "Chromium",
		darwin: "Chromium",
		linux: "chromium",
		win32: "Chromium/User Data",
	},
	{
		name: "Brave",
		darwin: "BraveSoftware/Brave-Browser",
		linux: "BraveSoftware/Brave-Browser",
		win32: "BraveSoftware/Brave-Browser/User Data",
	},
] as const;

/** Where to look for browser user data; each defaults to this user's. */
export interface ChromiumLocations {
	platform?: NodeJS.Platform;
	home?: string;
	/** Linux `$XDG_CONFIG_HOME`. */
	configHome?: string;
	/** Windows `%LOCALAPPDATA%`. */
	localAppData?: string;
}

/** A browser's user data directory: profiles, `Local State`, and on macOS and Linux `NativeMessagingHosts`. */
export interface ChromiumUserData {
	browser: string;
	dir: string;
}

/** The user data directory of every supported browser on this platform, whether or not it is installed. */
export function chromiumUserDataDirs(
	options: ChromiumLocations = {},
): ChromiumUserData[] {
	const platform = options.platform ?? process.platform;
	const home = options.home ?? os.homedir();
	let base: string;
	let key: "darwin" | "linux" | "win32";
	switch (platform) {
		case "darwin":
			base = path.join(home, "Library", "Application Support");
			key = "darwin";
			break;
		case "linux":
			base =
				options.configHome ??
				((options.home === undefined
					? process.env.XDG_CONFIG_HOME
					: undefined) ||
					path.join(home, ".config"));
			key = "linux";
			break;
		case "win32":
			base =
				options.localAppData ??
				((options.home === undefined ? process.env.LOCALAPPDATA : undefined) ||
					path.join(home, "AppData", "Local"));
			key = "win32";
			break;
		default:
			return [];
	}
	return BROWSERS.map((browser) => ({
		browser: browser.name,
		dir: path.join(base, ...browser[key].split("/")),
	}));
}

/** One browser profile and whether it has a given unpacked extension. */
export interface ChromiumProfileInstall {
	browser: string;
	/** The profile's display name. */
	profile: string;
	/** The profile has the extension loaded unpacked, switched on or off. */
	loaded: boolean;
	/** Loaded and switched on. */
	enabled: boolean;
	/** chrome://extensions has Developer mode on, which Load unpacked needs. */
	developerMode: boolean;
}

/** Chrome's `ManifestLocation::kUnpacked`, the location Load unpacked records. */
const UNPACKED_LOCATION = 4;

/**
 * Every profile of every installed supported browser, with whether it loads the unpacked extension `extensionId`.
 * Reads `Local State` and each profile's `Preferences` and `Secure Preferences`, which Chrome rewrites a few seconds
 * after a change; unreadable files count as absent.
 */
export async function findUnpackedInstalls(
	extensionId: string,
	options: ChromiumLocations = {},
): Promise<ChromiumProfileInstall[]> {
	const found: ChromiumProfileInstall[] = [];
	for (const { browser, dir } of chromiumUserDataDirs(options)) {
		const localState = await readJson(path.join(dir, "Local State"));
		const profiles =
			isRecord(localState) && isRecord(localState.profile)
				? localState.profile.info_cache
				: undefined;
		if (!isRecord(profiles)) continue;
		for (const [profileDir, info] of Object.entries(profiles)) {
			const prefs = await readJson(path.join(dir, profileDir, "Preferences"));
			const secure = await readJson(
				path.join(dir, profileDir, "Secure Preferences"),
			);
			const settings =
				extensionSettings(secure, extensionId) ??
				extensionSettings(prefs, extensionId);
			const loaded = settings?.location === UNPACKED_LOCATION;
			const reasons = settings?.disable_reasons;
			const disabled =
				settings?.state === 0 ||
				(Array.isArray(reasons)
					? reasons.length > 0
					: typeof reasons === "number" && reasons !== 0);
			found.push({
				browser,
				profile:
					isRecord(info) && typeof info.name === "string"
						? info.name
						: profileDir,
				loaded,
				enabled: loaded && !disabled,
				// A protected pref: Secure Preferences holds it where Chrome tracks prefs (macOS, Windows).
				developerMode: developerMode(secure) ?? developerMode(prefs) ?? false,
			});
		}
	}
	return found;
}

function developerMode(prefs: unknown): boolean | undefined {
	if (
		!isRecord(prefs) ||
		!isRecord(prefs.extensions) ||
		!isRecord(prefs.extensions.ui)
	)
		return undefined;
	const value = prefs.extensions.ui.developer_mode;
	return typeof value === "boolean" ? value : undefined;
}

function extensionSettings(
	prefs: unknown,
	extensionId: string,
): Record<string, unknown> | undefined {
	if (
		!isRecord(prefs) ||
		!isRecord(prefs.extensions) ||
		!isRecord(prefs.extensions.settings)
	)
		return undefined;
	const settings = prefs.extensions.settings[extensionId];
	return isRecord(settings) ? settings : undefined;
}

async function readJson(file: string): Promise<unknown> {
	try {
		return await Bun.file(file).json();
	} catch {
		return undefined;
	}
}

/**
 * Chromium browsers on this machine and their profiles, read from their user data directories without touching them:
 * where omp registers its native messaging host, and whether a profile already loads an omp install folder.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";

/** A supported Chromium browser: user data location, install location, and OSCrypt keychain entry. */
interface BrowserDefinition {
	name: string;
	darwin: string;
	linux: string;
	win32: string;
	/** macOS bundle name and id. */
	app?: string;
	bundleId?: string;
	/** Windows install path relative to a Program Files root. */
	winInstall?: string;
	keychain: string;
}

/** Chromium browsers omp supports, with each platform's user data directory relative to its base. */
const BROWSERS: readonly BrowserDefinition[] = [
	{
		name: "Google Chrome",
		darwin: "Google/Chrome",
		linux: "google-chrome",
		win32: "Google/Chrome/User Data",
		app: "Google Chrome.app",
		bundleId: "com.google.Chrome",
		winInstall: "Google\\Chrome",
		keychain: "Chrome Safe Storage",
	},
	{
		name: "Google Chrome Beta",
		darwin: "Google/Chrome Beta",
		linux: "google-chrome-beta",
		win32: "Google/Chrome Beta/User Data",
		app: "Google Chrome Beta.app",
		bundleId: "com.google.Chrome.beta",
		winInstall: "Google\\Chrome Beta",
		keychain: "Chrome Safe Storage",
	},
	{
		name: "Google Chrome Dev",
		darwin: "Google/Chrome Dev",
		linux: "google-chrome-unstable",
		win32: "Google/Chrome Dev/User Data",
		app: "Google Chrome Dev.app",
		bundleId: "com.google.Chrome.dev",
		winInstall: "Google\\Chrome Dev",
		keychain: "Chrome Safe Storage",
	},
	{
		name: "Google Chrome Canary",
		darwin: "Google/Chrome Canary",
		linux: "google-chrome-canary",
		win32: "Google/Chrome SxS/User Data",
		app: "Google Chrome Canary.app",
		bundleId: "com.google.Chrome.canary",
		winInstall: "Google\\Chrome SxS",
		keychain: "Chrome Safe Storage",
	},
	{
		name: "Chromium",
		darwin: "Chromium",
		linux: "chromium",
		win32: "Chromium/User Data",
		app: "Chromium.app",
		bundleId: "org.chromium.Chromium",
		winInstall: "Chromium",
		keychain: "Chromium Safe Storage",
	},
	{
		name: "Brave",
		darwin: "BraveSoftware/Brave-Browser",
		linux: "BraveSoftware/Brave-Browser",
		win32: "BraveSoftware/Brave-Browser/User Data",
		app: "Brave Browser.app",
		bundleId: "com.brave.Browser",
		winInstall: "BraveSoftware\\Brave-Browser",
		keychain: "Brave Safe Storage",
	},
	{
		name: "Brave Origin",
		darwin: "BraveSoftware/Brave-Origin",
		linux: "BraveSoftware/Brave-Origin",
		win32: "BraveSoftware/Brave-Origin/User Data",
		app: "Brave Origin.app",
		bundleId: "com.brave.Browser.origin",
		// Linux uses brave-origin and Windows ships brave.exe (not chrome.exe), so auto-load skips Origin there.
		keychain: "Brave Safe Storage",
	},
];

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
export function chromiumUserDataDirs(options: ChromiumLocations = {}): ChromiumUserData[] {
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
				((options.home === undefined ? process.env.XDG_CONFIG_HOME : undefined) || path.join(home, ".config"));
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
	return BROWSERS.map(browser => ({
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
		const profiles = isRecord(localState) && isRecord(localState.profile) ? localState.profile.info_cache : undefined;
		if (!isRecord(profiles)) continue;
		for (const [profileDir, info] of Object.entries(profiles)) {
			const prefs = await readJson(path.join(dir, profileDir, "Preferences"));
			const secure = await readJson(path.join(dir, profileDir, "Secure Preferences"));
			const settings = extensionSettings(secure, extensionId) ?? extensionSettings(prefs, extensionId);
			const loaded = settings?.location === UNPACKED_LOCATION;
			const reasons = settings?.disable_reasons;
			const disabled =
				settings?.state === 0 ||
				(Array.isArray(reasons) ? reasons.length > 0 : typeof reasons === "number" && reasons !== 0);
			found.push({
				browser,
				profile: isRecord(info) && typeof info.name === "string" ? info.name : profileDir,
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
	if (!isRecord(prefs) || !isRecord(prefs.extensions) || !isRecord(prefs.extensions.ui)) return undefined;
	const value = prefs.extensions.ui.developer_mode;
	return typeof value === "boolean" ? value : undefined;
}

function extensionSettings(prefs: unknown, extensionId: string): Record<string, unknown> | undefined {
	if (!isRecord(prefs) || !isRecord(prefs.extensions) || !isRecord(prefs.extensions.settings)) return undefined;
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

/** An installed Chromium browser with the paths needed to stop, restart and seed-extract it. */
export interface ChromiumBrowser {
	name: string;
	/** Profile root holding `Local State`. */
	dir: string;
	/** Browser executable, the anchor for both process matching and resource packs. */
	executable: string;
	app?: string;
	bundleId?: string;
	/** macOS OSCrypt keychain entry. */
	keychain: string;
	/** Directories that may hold `.pak` resources next to the build. */
	resourceDirs: string[];
}

/** Resolves the browser executable on this platform, or undefined when it is not installed. */
async function browserExecutable(browser: BrowserDefinition, platform: NodeJS.Platform): Promise<string | undefined> {
	if (platform === "darwin" && browser.app) {
		const name = browser.app.replace(/\.app$/, "");
		for (const root of [path.join(os.homedir(), "Applications"), "/Applications"]) {
			const candidate = path.join(root, browser.app, "Contents", "MacOS", name);
			if (await Bun.file(candidate).exists()) return candidate;
		}
		return undefined;
	}
	if (platform === "win32" && browser.winInstall) {
		for (const root of [
			process.env.ProgramFiles ?? "C:\\Program Files",
			process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
		]) {
			const candidate = path.join(root, browser.winInstall, "Application", "chrome.exe");
			if (await Bun.file(candidate).exists()) return candidate;
		}
		return undefined;
	}
	if (platform === "linux") return Bun.which(browser.linux) ?? undefined;
	return undefined;
}

/** Every supported browser that is installed and has a profile root, de-duplicated by user data directory. */
export async function installedChromiumBrowsers(options: ChromiumLocations = {}): Promise<ChromiumBrowser[]> {
	const platform = options.platform ?? process.platform;
	const seen = new Set<string>();
	const installed: ChromiumBrowser[] = [];
	for (const { browser, dir } of chromiumUserDataDirs(options)) {
		const key = platform === "win32" ? dir.toLowerCase() : dir;
		if (seen.has(key)) continue;
		seen.add(key);
		const definition = BROWSERS.find(entry => entry.name === browser)!;
		const executable = await browserExecutable(definition, platform);
		if (!executable) continue;
		if (!(await Bun.file(path.join(dir, "Local State")).exists())) continue;
		installed.push({
			name: browser,
			dir,
			executable,
			app: definition.app,
			bundleId: definition.bundleId,
			keychain: definition.keychain,
			resourceDirs: platform === "darwin" ? [] : [path.dirname(executable)],
		});
	}
	return installed;
}

/** The profile Chrome itself used last, falling back to `Default`. */
export async function lastUsedProfile(userDataDir: string): Promise<string> {
	const state = await readJson(path.join(userDataDir, "Local State"));
	const lastUsed =
		isRecord(state) && isRecord(state.profile) && typeof state.profile.last_used === "string"
			? state.profile.last_used
			: undefined;
	if (lastUsed && (await Bun.file(path.join(userDataDir, lastUsed, "Preferences")).exists())) {
		return lastUsed;
	}
	return "Default";
}

/** Process ids of `browser`, matched on its executable path (or macOS application name). */
async function browserProcessIds(browser: ChromiumBrowser): Promise<number[]> {
	const result =
		process.platform === "win32"
			? await Bun.$`tasklist /FI ${`IMAGENAME eq ${path.basename(browser.executable)}`} /FO CSV /NH`
					.quiet()
					.nothrow()
			: await Bun.$`ps -Ao pid=,command=`.quiet().nothrow();
	if (result.exitCode !== 0) return [];
	const pids: number[] = [];
	for (const line of result.stdout.toString().split("\n")) {
		if (!line.includes(browser.executable) && !(browser.app && line.includes(browser.app))) continue;
		const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? "", 10);
		if (Number.isFinite(pid)) pids.push(pid);
	}
	return pids;
}

/**
 * Gracefully stops every instance of `browser`, forcing it after `timeoutMs`. Chrome rewrites preference files from
 * memory, so a profile must not be edited while its browser runs. Returns whether the browser was running.
 */
export async function stopBrowser(browser: ChromiumBrowser, timeoutMs = 15_000): Promise<boolean> {
	if ((await browserProcessIds(browser)).length === 0) return false;
	if (process.platform === "darwin" && browser.app) {
		const name = browser.app.replace(/\.app$/, "");
		await Bun.$`osascript -e ${`tell application "${name}" to quit`}`.quiet().nothrow();
	} else if (process.platform === "win32") {
		await Bun.$`taskkill /IM ${path.basename(browser.executable)}`.quiet().nothrow();
	} else {
		await Bun.$`pkill -TERM -f ${browser.executable}`.quiet().nothrow();
	}
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if ((await browserProcessIds(browser)).length === 0) return true;
		await Bun.sleep(150);
	}
	await Bun.$`pkill -KILL -f ${browser.executable}`.quiet().nothrow();
	return true;
}

/** Starts `browser` again after a preference write. */
export async function startBrowser(browser: ChromiumBrowser): Promise<void> {
	if (process.platform === "darwin") {
		if (browser.bundleId) await Bun.$`open -b ${browser.bundleId}`.quiet().nothrow();
		else if (browser.app) await Bun.$`open -a ${path.join("/Applications", browser.app)}`.quiet().nothrow();
		return;
	}
	Bun.spawn([browser.executable], { stdio: ["ignore", "ignore", "ignore"] }).unref();
}

/** Resource packs that may carry the pref-hash seed; on macOS they sit in the framework's versioned Resources. */
export async function seedPaks(browser: ChromiumBrowser): Promise<string[]> {
	const dirs = [...browser.resourceDirs];
	if (process.platform === "darwin") {
		const frameworks = path.join(path.dirname(browser.executable), "..", "Frameworks");
		for (const version of await fs.readdir(frameworks).catch(() => [] as string[])) {
			const resources = path.join(frameworks, version, "Resources");
			if (await Bun.file(path.join(resources, "resources.pak")).exists()) dirs.push(resources);
		}
	}
	const paks: string[] = [];
	const addPaks = async (dir: string): Promise<void> => {
		for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
			if (name === "resources.pak" || /^chrome_(100|200)_percent\.pak$/.test(name)) paks.push(path.join(dir, name));
		}
		for (const [localeDir, localeFile] of [
			["en.lproj", "locale.pak"],
			["locales", "en-US.pak"],
		] as const) {
			const file = path.join(dir, localeDir, localeFile);
			if (await Bun.file(file).exists()) paks.push(file);
		}
	};
	for (const dir of dirs) {
		await addPaks(dir);
		// Windows keeps each build's packs one level down, beside chrome.exe's versioned directory.
		for (const version of await fs.readdir(dir).catch(() => [] as string[])) {
			if (/^\d+\./.test(version)) await addPaks(path.join(dir, version));
		}
	}
	return paks;
}

/** Whether adjacent Chromium browsers share this browser's profile root (the same relaunch scope). */
export function sameProfileRoot(a: ChromiumBrowser, b: ChromiumBrowser): boolean {
	return a.dir === b.dir;
}

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { findUnpackedInstalls, installedChromiumBrowsers } from "../../src/tools/browser/relay/chromium-profiles";

const ID = "abcdefghijklmnopabcdefghijklmnop";

let home: TempDir;

beforeEach(async () => {
	home = await TempDir.create("@omp-chromium-profiles-");
});

afterEach(async () => {
	vi.restoreAllMocks();
	await home.remove();
});

async function profile(browserDir: string, dir: string, files: { prefs?: unknown; secure?: unknown }): Promise<void> {
	const root = home.join("Library/Application Support", browserDir, dir);
	if (files.prefs !== undefined) await Bun.write(`${root}/Preferences`, JSON.stringify(files.prefs));
	if (files.secure !== undefined) await Bun.write(`${root}/Secure Preferences`, JSON.stringify(files.secure));
}

async function localState(browserDir: string, profiles: Record<string, string>): Promise<void> {
	const info_cache = Object.fromEntries(Object.entries(profiles).map(([dir, name]) => [dir, { name }]));
	await Bun.write(
		home.join("Library/Application Support", browserDir, "Local State"),
		JSON.stringify({ profile: { info_cache } }),
	);
}

describe("findUnpackedInstalls", () => {
	it("reports per profile whether the unpacked extension is loaded, switched on, and Developer mode", async () => {
		await localState("Google/Chrome", {
			Default: "Work",
			"Profile 1": "Home",
			"Profile 2": "Spare",
		});
		// Load unpacked records the extension in Secure Preferences on macOS.
		await profile("Google/Chrome", "Default", {
			prefs: { extensions: { ui: { developer_mode: true } } },
			secure: {
				extensions: {
					settings: { [ID]: { location: 4, disable_reasons: [] } },
				},
			},
		});
		await profile("Google/Chrome", "Profile 1", {
			prefs: {
				extensions: {
					settings: { [ID]: { location: 4, disable_reasons: [1] } },
				},
			},
		});
		// Same id from the Web Store (location 1) is not this folder; unparsable prefs count as absent.
		await profile("Google/Chrome", "Profile 2", {
			secure: { extensions: { settings: { [ID]: { location: 1 } } } },
		});
		await Bun.write(home.join("Library/Application Support/Google/Chrome/Profile 2/Preferences"), "{");
		// A browser without Local State is not installed.
		await profile("Chromium", "Default", {
			secure: { extensions: { settings: { [ID]: { location: 4 } } } },
		});
		// A fork that keeps its profiles outside Chrome's directories is found in its own.
		await localState("net.imput.helium", { Default: "Personal" });
		await profile("net.imput.helium", "Default", {
			secure: {
				extensions: {
					settings: { [ID]: { location: 4, disable_reasons: [] } },
					ui: { developer_mode: true },
				},
			},
		});

		const found = await findUnpackedInstalls(ID, {
			platform: "darwin",
			home: home.path(),
		});
		expect(found).toEqual([
			{
				browser: "Google Chrome",
				profile: "Work",
				loaded: true,
				enabled: true,
				developerMode: true,
			},
			{
				browser: "Google Chrome",
				profile: "Home",
				loaded: true,
				enabled: false,
				developerMode: false,
			},
			{
				browser: "Google Chrome",
				profile: "Spare",
				loaded: false,
				enabled: false,
				developerMode: false,
			},
			{
				browser: "Helium",
				profile: "Personal",
				loaded: true,
				enabled: true,
				developerMode: true,
			},
		]);
	});
});

describe("installedChromiumBrowsers", () => {
	it("finds a Linux browser by its executable name, not by its profile directory name", async () => {
		await Bun.write(home.join(".config/net.imput.helium/Local State"), "{}");
		vi.spyOn(Bun, "which").mockImplementation(command => (command === "helium" ? "/opt/helium/helium" : null));

		const installed = await installedChromiumBrowsers({ platform: "linux", home: home.path() });
		expect(installed.map(browser => [browser.name, browser.dir, browser.executable])).toEqual([
			["Helium", home.join(".config/net.imput.helium"), "/opt/helium/helium"],
		]);
	});

	it("finds a Windows browser that is installed for the current user only", async () => {
		const localAppData = home.join("AppData/Local");
		await Bun.write(path.join(localAppData, "imput", "Helium", "User Data", "Local State"), "{}");
		const executable = path.join(localAppData, "imput\\Helium", "Application", "chrome.exe");
		await Bun.write(executable, "");

		const installed = await installedChromiumBrowsers({ platform: "win32", localAppData });
		expect(installed.map(browser => [browser.name, browser.executable])).toEqual([["Helium", executable]]);
	});
});

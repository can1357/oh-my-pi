import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { findUnpackedInstalls } from "../../src/tools/browser/relay/chromium-profiles";

const ID = "abcdefghijklmnopabcdefghijklmnop";

let home: TempDir;

beforeEach(async () => {
	home = await TempDir.create("@omp-chromium-profiles-");
});

afterEach(async () => {
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
		]);
	});

	it("detects an unpacked extension in Windows Brave Origin profiles", async () => {
		const root = home.join("AppData/Local/BraveSoftware/Brave-Origin/User Data");
		await Bun.write(
			`${root}/Local State`,
			JSON.stringify({ profile: { info_cache: { Default: { name: "Default" } } } }),
		);
		await Bun.write(
			`${root}/Default/Preferences`,
			JSON.stringify({
				extensions: {
					ui: { developer_mode: true },
					settings: { [ID]: { location: 4, disable_reasons: [] } },
				},
			}),
		);

		const found = await findUnpackedInstalls(ID, {
			platform: "win32",
			home: home.path(),
		});
		expect(found).toEqual([
			{
				browser: "Brave Origin",
				profile: "Default",
				loaded: true,
				enabled: true,
				developerMode: true,
			},
		]);
	});
});

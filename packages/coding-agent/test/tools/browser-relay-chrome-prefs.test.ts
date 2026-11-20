import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	authenticator,
	authenticatorSamples,
	discoverSeed,
	plainHash,
	type AuthenticatorSample,
} from "../../src/tools/browser/relay/chrome/authenticators";
import { chromiumJson, type JsonValue } from "../../src/tools/browser/relay/chrome/canonical-json";
import { registerUnpackedExtension } from "../../src/tools/browser/relay/chrome/secure-store";
import type { ChromiumBrowser } from "../../src/tools/browser/relay/chromium-profiles";

/** Seed shipped by Chrome 157.0.8103.79 (`IDR_PREF_HASH_SEED_BIN`). */
const SEED = Buffer.from(
	"e748f336d85ea5f9dcdf25d8f347a65b4cdf667600f02df6724a2af18a212d26b788a25086910cf3a90313696871f3dc05823730c91df8ba5c4fd9c884b505a8",
	"hex",
);
const DEVICE = "C0A0242B-31F5-5C2A-99E2-61A95E95FFC1";

/** Record Chrome itself wrote for the relay folder (unpacked, manual load), used as a hash regression. */
const RELAY_RECORD: JsonValue = {
	account_extension_type: 0,
	active_permissions: {
		api: [
			"alarms",
			"debugger",
			"downloads",
			"nativeMessaging",
			"notifications",
			"storage",
			"tabs",
			"unlimitedStorage",
			"tabGroups",
			"scripting",
			"offscreen",
			"sidePanel",
		],
		explicit_host: ["<all_urls>"],
		manifest_permissions: [],
		scriptable_host: [],
	},
	commands: {
		_execute_action: {
			was_assigned: true,
		},
		"toggle-side-panel": {
			suggested_key: "Command+E",
			was_assigned: true,
		},
	},
	content_settings: [],
	creation_flags: 32806,
	disable_reasons: [],
	first_install_time: "13439648642412859",
	from_webstore: false,
	granted_permissions: {
		api: [
			"alarms",
			"debugger",
			"downloads",
			"nativeMessaging",
			"notifications",
			"storage",
			"tabs",
			"unlimitedStorage",
			"tabGroups",
			"scripting",
			"offscreen",
			"sidePanel",
		],
		explicit_host: ["<all_urls>"],
		manifest_permissions: [],
		scriptable_host: [],
	},
	incognito_content_settings: [],
	incognito_preferences: {},
	install_time_for_action_metric: "13439648642414176",
	last_update_time: "13439648642412859",
	location: 4,
	newAllowFileAccess: true,
	path: "/Users/can/.omp/browser-relay/extension",
	preferences: {},
	regular_only_preferences: {},
	serviceworkerevents: [],
	was_installed_by_default: false,
	was_installed_by_oem: false,
	was_pinned_by_default: true,
	withholding_permissions: false,
};

describe("chromiumJson", () => {
	test("prunes empty containers, orders fields, and escapes only Chromium's special characters", () => {
		const value: JsonValue = { a: "<all_urls>", b: [1, "x"], empty: {}, nested: { gone: [] }, sp: "a&b>c" };
		expect(chromiumJson(value)).toBe('{"a":"\\u003Call_urls>","b":[1,"x"],"sp":"a&b>c"}');
	});

	test("escapes control characters and the line separators", () => {
		expect(chromiumJson("a\tb\n\u2028c")).toBe('"a\\tb\\n\\u2028c"');
	});
});

describe("authenticator", () => {
	test("reproduces the authenticator Chrome wrote for the relay record", () => {
		expect(authenticator(SEED, DEVICE, "extensions.settings.eicceepiabigdcbkjcbcocekjaobhnje", RELAY_RECORD)).toBe(
			"5382B7F41493C597BFDB0A4EF135F3CADFE20C6761C5647CD2151DF545E307A3",
		);
	});

	test("hashes the value without the device id for OSCrypt", () => {
		expect(plainHash(SEED, "extensions.settings.testid", { a: 1 }).toString("hex")).toBe(
			"4611b40eace965fcc770a1e3285a47541c9ae7aeb3886d3d0ae225aabd06ed47",
		);
	});
});

/** Writes a minimal v5 pak holding the given payloads. */
async function writePak(file: string, payloads: Buffer[]): Promise<void> {
	const headerBytes = 12 + (payloads.length + 1) * 6;
	const parts: Buffer[] = [];
	const header = Buffer.alloc(12);
	header.writeUInt32LE(5, 0);
	header.writeUInt16LE(payloads.length, 8);
	parts.push(header);
	let offset = headerBytes;
	for (const payload of payloads) {
		const entry = Buffer.alloc(6);
		entry.writeUInt16LE(parts.length, 0);
		entry.writeUInt32LE(offset, 2);
		parts.push(entry);
		offset += payload.length;
	}
	const sentinel = Buffer.alloc(6);
	sentinel.writeUInt32LE(offset, 2);
	parts.push(sentinel, ...payloads);
	await Bun.write(file, Buffer.concat(parts));
}

describe("discoverSeed", () => {
	test("recovers the seed from a resource pack using the profile's own authenticators", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seed-"));
		try {
			const pak = path.join(dir, "resources.pak");
			await writePak(pak, [Buffer.from("noise"), SEED]);
			const samples: AuthenticatorSample[] = [
				{
					path: "browser.show_home_button",
					mac: "6C8ECEFCB963DE7248577B0105A76C942F6EA574028474F3E822873CF6FA7622",
				},
			];
			expect((await discoverSeed([pak], DEVICE, samples)).equals(SEED)).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("rejects a pack that carries no matching seed", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-seed-"));
		try {
			const pak = path.join(dir, "resources.pak");
			await writePak(pak, [Buffer.from("not-the-seed")]);
			const samples: AuthenticatorSample[] = [
				{
					path: "browser.show_home_button",
					mac: "6C8ECEFCB963DE7248577B0105A76C942F6EA574028474F3E822873CF6FA7622",
				},
			];
			await expect(discoverSeed([pak], DEVICE, samples)).rejects.toThrow("Could not recover");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("authenticatorSamples", () => {
	test("collects only authenticators whose value is available", () => {
		const samples = authenticatorSamples(
			{ extensions: { settings: { abc: "MAC" }, ui: { developer_mode: "MAC2" } } },
			{ extensions: { settings: { abc: { path: "/x" } } } },
		);
		expect(samples).toEqual([
			{ path: "extensions.settings.abc", value: { path: "/x" }, mac: "MAC" },
			{ path: "extensions.ui.developer_mode", mac: "MAC2" },
		]);
	});
});

const browser = {
	name: "Google Chrome",
	dir: "/nonexistent",
	executable: "/nonexistent/chrome",
	keychain: "Chrome Safe Storage",
	resourceDirs: [],
} satisfies ChromiumBrowser;

describe("registerUnpackedExtension", () => {
	test("writes a loadable record with an authenticator and refreshed super authenticators", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-profile-"));
		const extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-extension-"));
		const profileDir = path.join(dir, "Default");
		try {
			await fs.mkdir(profileDir);
			await Bun.write(
				path.join(extensionDir, "manifest.json"),
				JSON.stringify({ manifest_version: 3, name: "omp" }),
			);
			const seedPak = path.join(dir, "resources.pak");
			await writePak(seedPak, [SEED]);
			const secureFile = path.join(profileDir, "Secure Preferences");
			await Bun.write(
				secureFile,
				JSON.stringify({
					browser: { show_home_button: false },
					extensions: { settings: {}, ui: { developer_mode: false } },
					protection: {
						macs: {
							browser: { show_home_button: "6C8ECEFCB963DE7248577B0105A76C942F6EA574028474F3E822873CF6FA7622" },
							extensions: {
								ui: { developer_mode: authenticator(SEED, DEVICE, "extensions.ui.developer_mode", false) },
							},
						},
						super_mac: "stale",
					},
				}),
			);
			const result = await registerUnpackedExtension(
				{ ...browser, resourceDirs: [dir] },
				profileDir,
				"abcdefghijklmnopabcdefghijklmnop",
				{
					location: 4,
					path: extensionDir,
					disable_reasons: [],
				},
			);
			expect(result.protected).toBe(true);
			expect(result.authenticators).toBe(process.platform === "darwin" ? "hmac+encrypted" : "hmac");
			const written = await Bun.file(secureFile).json();
			const record = written.extensions.settings.abcdefghijklmnopabcdefghijklmnop;
			expect(record.location).toBe(4);
			expect(written.extensions.ui.developer_mode).toBe(true);
			const macs = written.protection.macs;
			expect(macs.extensions.settings.abcdefghijklmnopabcdefghijklmnop).toBe(
				authenticator(SEED, DEVICE, "extensions.settings.abcdefghijklmnopabcdefghijklmnop", record),
			);
			expect(macs.extensions.ui.developer_mode).toBe(
				authenticator(SEED, DEVICE, "extensions.ui.developer_mode", true),
			);
			expect(written.protection.super_mac).toBe(authenticator(SEED, DEVICE, "", macs as JsonValue));
			expect(await Bun.file(`${secureFile}.omp-backup`).exists()).toBe(true);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
			await fs.rm(extensionDir, { recursive: true, force: true });
		}
	});
});

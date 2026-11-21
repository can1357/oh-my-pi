/**
 * Unattended `omp browser-relay install` into real Chrome profiles: build the install record Chrome would write for
 * "Load unpacked", write it with authenticators, and restart the browser it was taken from.
 */
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import { unpackedExtensionId } from "../extension-files";
import type { JsonValue } from "./canonical-json";
import {
	type ChromiumBrowser,
	installedChromiumBrowsers,
	lastUsedProfile,
	startBrowser,
	stopBrowser,
} from "../chromium-profiles";
import { type AuthenticatorMode, registerUnpackedExtension } from "./secure-store";

/** Options of {@link installRelayInChrome}. */
export interface ChromeInstallOptions {
	/** Canonical extension directory the profile must load. */
	dir: string;
	/** Browser name from the installed-browser list; defaults to Google Chrome, else the first installed. */
	browser?: string;
	/** Profile directory name such as `Default` or `Profile 1`; defaults to the one Chrome used last. */
	profile?: string;
}

/** One profile that now carries the extension. */
export interface ChromeInstallReport {
	browser: string;
	profileDir: string;
	authenticators: AuthenticatorMode;
	/** Whether the browser was running, and was therefore restarted by the install. */
	restarted: boolean;
}

/** Chrome's `creation_flags` for a manual unpacked load: symlinks, file access, modern manifest. */
const UNPACKED_CREATION_FLAGS = (1 << 5) | (1 << 2) | (1 << 1);

function manifestList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

async function buildRecord(dir: string): Promise<{ id: string; record: Record<string, JsonValue> }> {
	const manifest: unknown = await Bun.file(path.join(dir, "manifest.json")).json();
	if (!isRecord(manifest)) throw new Error(`No extension manifest at ${dir}`);
	const id = await unpackedExtensionId(dir);
	if (!id) throw new Error(`Extension directory is missing: ${dir}`);
	const version = typeof manifest.version === "string" ? manifest.version : "0";
	const permissions = manifestList(manifest.permissions);
	const hosts = manifestList(manifest.host_permissions);
	const commands: Record<string, JsonValue> = {};
	if (isRecord(manifest.commands)) {
		for (const name in manifest.commands) {
			const command = manifest.commands[name];
			if (!isRecord(command)) continue;
			const suggested = command.suggested_key;
			commands[name] = {
				suggested_key: typeof suggested === "string" ? suggested : (suggested as JsonValue),
				was_assigned: true,
			};
		}
	}
	const permissionSet = (): JsonValue => ({
		api: permissions,
		explicit_host: hosts,
		manifest_permissions: [],
		scriptable_host: [],
	});
	const now = String((Date.now() + 11_644_473_600_000) * 1000);
	return {
		id,
		record: {
			account_extension_type: 0,
			active_permissions: permissionSet(),
			commands,
			content_settings: [],
			creation_flags: UNPACKED_CREATION_FLAGS,
			disable_reasons: [],
			first_install_time: now,
			from_webstore: false,
			granted_permissions: permissionSet(),
			incognito_content_settings: [],
			incognito_preferences: {},
			install_time_for_action_metric: now,
			last_update_time: now,
			location: 4,
			newAllowFileAccess: true,
			open_side_panel_on_icon_click: "side_panel" in manifest,
			path: dir,
			preferences: {},
			regular_only_preferences: {},
			service_worker_registration_info: { version },
			was_installed_by_default: false,
			was_installed_by_oem: false,
			was_pinned_by_default: true,
			withholding_permissions: false,
		},
	};
}

function pickBrowser(browsers: readonly ChromiumBrowser[], wanted: string | undefined): ChromiumBrowser | undefined {
	const name = wanted?.toLowerCase();
	return (
		(name ? browsers.find(browser => browser.name.toLowerCase().includes(name)) : undefined) ??
		browsers.find(browser => browser.name === "Google Chrome") ??
		browsers[0]
	);
}

/**
 * Registers the already-staged extension in one profile of one installed Chromium browser. Chrome overwrites
 * preference files from memory, so a running browser is asked to quit and started again afterwards.
 */
export async function installRelayInChrome(options: ChromeInstallOptions): Promise<ChromeInstallReport[]> {
	const browser = pickBrowser(await installedChromiumBrowsers(), options.browser);
	if (!browser) return [];
	const profile = options.profile ?? (await lastUsedProfile(browser.dir));
	const profileDir = path.join(browser.dir, profile);
	if (!(await Bun.file(path.join(profileDir, "Preferences")).exists())) {
		throw new Error(`Chrome profile not found: ${profileDir}`);
	}
	const { id, record } = await buildRecord(options.dir);
	const restarted = await stopBrowser(browser);
	try {
		const result = await registerUnpackedExtension(browser, profileDir, id, record);
		return [
			{ browser: browser.name, profileDir: result.profileDir, authenticators: result.authenticators, restarted },
		];
	} finally {
		if (restarted) await startBrowser(browser);
	}
}

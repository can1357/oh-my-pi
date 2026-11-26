/**
 * Writing an unpacked-extension install record into a Chrome profile the way Chrome's own "Load unpacked" does.
 *
 * Chrome stores `extensions.settings.<id>` split-authenticated: a legacy HMAC and, since `kEncryptedPrefHashing`, an
 * OSCrypt-encrypted hash that validation prefers. Both are regenerated here together with the store's super
 * authenticators over `protection.macs`, so Chrome keeps the record instead of resetting it as tampered.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import { writeFileAtomically } from "../../../../utils/atomic-file";
import { authenticator, authenticatorSamples, deviceId, discoverSeed, plainHash } from "./authenticators";
import type { JsonValue } from "./canonical-json";
import { encryptString } from "./oscrypt";
import { type ChromiumBrowser, seedPaks } from "../chromium-profiles";

/** How the record was authenticated, for the install report. */
export type AuthenticatorMode = "hmac+encrypted" | "hmac" | "unauthenticated";

/** Outcome of registering one unpacked extension in a profile. */
export interface ChromeInstallResult {
	profileDir: string;
	protected: boolean;
	authenticators: AuthenticatorMode;
}

interface PrefFiles {
	secure: Record<string, unknown>;
	normal: Record<string, unknown>;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
	const data = await Bun.file(file)
		.json()
		.catch(error => {
			if (isEnoent(error)) return {};
			throw error;
		});
	return isRecord(data) ? data : {};
}

function child(node: Record<string, unknown>, key: string): Record<string, unknown> {
	const existing = node[key];
	if (isRecord(existing)) return existing;
	const created: Record<string, unknown> = {};
	node[key] = created;
	return created;
}

function settingsOf(prefs: Record<string, unknown>): Record<string, unknown> {
	return child(child(prefs, "extensions"), "settings");
}

/** True when the profile keeps extension settings in `Secure Preferences` (macOS/Windows protection). */
function isProtected(secure: Record<string, unknown>): boolean {
	if (isRecord(secure.extensions)) return true;
	const protection = secure.protection;
	return isRecord(protection) && isRecord(protection.macs) && "extensions" in protection.macs;
}

/** Removes empty dictionaries and lists bottom-up, matching what the super authenticator covers. */
function pruneEmpty(node: JsonValue): JsonValue {
	if (Array.isArray(node)) {
		const items: JsonValue[] = [];
		for (const item of node) {
			const pruned = pruneEmpty(item);
			if (Array.isArray(pruned) && pruned.length === 0) continue;
			if (isRecord(pruned) && Object.keys(pruned).length === 0) continue;
			items.push(pruned);
		}
		return items;
	}
	if (isRecord(node)) {
		const result: Record<string, JsonValue> = {};
		for (const key in node) result[key] = pruneEmpty(node[key] as JsonValue);
		return result;
	}
	return node;
}

/** Encrypted-hash map that only carries `*_encrypted_hash` keys, as the super encrypted hash covers. */
function encryptedHashesOnly(node: JsonValue): Record<string, JsonValue> {
	const result: Record<string, JsonValue> = {};
	if (!isRecord(node)) return result;
	for (const key in node) {
		const value = node[key] as JsonValue;
		if (key.endsWith("_encrypted_hash")) result[key] = value;
		else if (isRecord(value)) {
			const nested = encryptedHashesOnly(value);
			if (Object.keys(nested).length > 0) result[key] = nested;
		}
	}
	return result;
}

async function backup(file: string): Promise<void> {
	await fs.copyFile(file, `${file}.omp-backup`).catch(() => {});
}

/**
 * Installs `record` under `id` in `profileDir`. The browser owning the profile must be stopped. The previous file is
 * kept beside the new one for manual recovery.
 */
export async function registerUnpackedExtension(
	browser: ChromiumBrowser,
	profileDir: string,
	id: string,
	record: Record<string, JsonValue>,
): Promise<ChromeInstallResult> {
	const secureFile = path.join(profileDir, "Secure Preferences");
	const normalFile = path.join(profileDir, "Preferences");
	const files: PrefFiles = { secure: await readJson(secureFile), normal: await readJson(normalFile) };
	const protectedStore = isProtected(files.secure);
	const targetFile = protectedStore ? secureFile : normalFile;
	const target = settingsOf(protectedStore ? files.secure : files.normal);
	const existing = target[id];
	target[id] = isRecord(existing)
		? { ...record, first_install_time: (existing.first_install_time as JsonValue) ?? record.first_install_time }
		: record;

	let mode: AuthenticatorMode = "unauthenticated";
	if (protectedStore) {
		const device = await deviceId();
		const protection = child(files.secure, "protection");
		const macs = child(protection, "macs");
		const seed = await discoverSeed(
			await seedPaks(browser),
			device,
			authenticatorSamples(macs as JsonValue, files.secure as JsonValue),
		);
		const extensionMacs = child(macs, "extensions");
		const prefPath = `extensions.settings.${id}`;
		child(extensionMacs, "settings")[id] = authenticator(seed, device, prefPath, target[id] as JsonValue);
		child(child(files.secure, "extensions"), "ui").developer_mode = true;
		const uiMacs = child(extensionMacs, "ui");
		uiMacs.developer_mode = authenticator(seed, device, "extensions.ui.developer_mode", true);
		if (process.platform === "darwin") {
			child(extensionMacs, "settings_encrypted_hash")[id] = await encryptString(
				browser.keychain,
				plainHash(seed, prefPath, target[id] as JsonValue),
			);
			uiMacs.developer_mode_encrypted_hash = await encryptString(
				browser.keychain,
				plainHash(seed, "extensions.ui.developer_mode", true),
			);
			const filtered = encryptedHashesOnly(macs as JsonValue);
			if (Object.keys(filtered).length > 0) {
				protection.super_encrypted_hash = await encryptString(browser.keychain, plainHash(seed, "", filtered));
			}
			mode = "hmac+encrypted";
		} else {
			delete extensionMacs.settings_encrypted_hash;
			delete uiMacs.developer_mode_encrypted_hash;
			delete protection.super_encrypted_hash;
			mode = "hmac";
		}
		protection.super_mac = authenticator(seed, device, "", pruneEmpty(macs as JsonValue));
	}

	await fs.mkdir(profileDir, { recursive: true });
	await backup(targetFile);
	await writeFileAtomically(targetFile, `${JSON.stringify(protectedStore ? files.secure : files.normal, null, 3)}\n`);
	return { profileDir, protected: protectedStore, authenticators: mode };
}

/**
 * Kimi Code OAuth flow (device authorization grant)
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import packageJson from "../../../package.json" with { type: "json" };

const DEVICE_ID_FILENAME = "kimi-device-id";

function formatDeviceModel(system: string, release: string, arch: string): string {
	return [system, release, arch].filter(Boolean).join(" ").trim();
}

function getDeviceModel(): string {
	const platform = os.platform();
	const release = os.release();
	const arch = os.arch();
	if (platform === "darwin") return formatDeviceModel("macOS", release, arch);
	if (platform === "win32") return formatDeviceModel("Windows", release, arch);
	const label = platform === "linux" ? "Linux" : platform;
	return formatDeviceModel(label, release, arch);
}

// Device id identifies this install to Kimi. Persistence is best-effort: a
// missing/unwritable agent dir must never break header construction (and with
// it every usage probe / request that spreads getKimiCommonHeaders()) — fall
// back to a per-process ephemeral id instead.
let getDeviceId = (): string => {
	const deviceIdPath = path.join(getAgentDir(), DEVICE_ID_FILENAME);
	try {
		const existing = fs.readFileSync(deviceIdPath, "utf-8").trim();
		if (existing) {
			getDeviceId = () => existing;
			return existing;
		}
	} catch {
		// Unreadable device-id file: regenerate below.
	}

	const deviceId = crypto.randomUUID().replace(/-/g, "");
	try {
		fs.mkdirSync(path.dirname(deviceIdPath), { recursive: true });
		fs.writeFileSync(deviceIdPath, `${deviceId}\n`, { mode: 0o600 });
	} catch {
		// Persist failure → ephemeral id for this process.
	}
	getDeviceId = () => deviceId;
	return deviceId;
};

function sanitizeHeaderValue(value: string, fallback = ""): string {
	const sanitized = value.replace(/[^\x20-\x7E]/g, "").trim();
	return sanitized || fallback;
}

export let getKimiCommonHeaders = () => {
	const headers = Object.freeze({
		"User-Agent": `KimiCLI/${packageJson.version}`,
		"X-Msh-Platform": "kimi_cli",
		"X-Msh-Version": packageJson.version,
		"X-Msh-Device-Name": sanitizeHeaderValue(os.hostname(), "unknown"),
		"X-Msh-Device-Model": sanitizeHeaderValue(getDeviceModel(), "unknown"),
		"X-Msh-Os-Version": sanitizeHeaderValue(os.version(), "unknown"),
		"X-Msh-Device-Id": sanitizeHeaderValue(getDeviceId(), "unknown"),
	});
	getKimiCommonHeaders = () => headers;
	return headers;
};

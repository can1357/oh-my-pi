/**
 * Shared collab link file: the collab host writes its active share link here so
 * the Pi Speak gateway can read it and expose it to the phone app. Best-effort
 * only — writing/reading must never throw into the host process.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Resolve the Pi Speak config dir per the shared gateway contract. */
function resolveConfigDir(): string {
	if (process.env.PI_SPEAK_CONFIG_DIR) return process.env.PI_SPEAK_CONFIG_DIR;
	if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, "pi-speak");
	if (process.env.APPDATA) return path.join(process.env.APPDATA, "pi-speak");
	return path.join(process.cwd(), ".pi-speak");
}

function collabFilePath(): string {
	return path.join(resolveConfigDir(), "collab.json");
}

/** Persist the active collab share link so the gateway can expose it. */
export function writeCollabLinkFile(info: {
	webLink: string;
	webViewLink: string;
	link: string;
	viewLink: string;
	view: boolean;
}): void {
	try {
		const dir = resolveConfigDir();
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		const payload = { active: true, ...info, startedAt: new Date().toISOString() };
		fs.writeFileSync(collabFilePath(), JSON.stringify(payload, null, 2));
	} catch {
		// Best-effort: never throw into the collab host.
	}
}

/** Flip the collab link file to inactive when the host collab ends. */
export function clearCollabLinkFile(): void {
	try {
		const dir = resolveConfigDir();
		if (!fs.existsSync(dir)) return;
		fs.writeFileSync(collabFilePath(), JSON.stringify({ active: false }, null, 2));
	} catch {
		// Best-effort: never throw into the collab host.
	}
}

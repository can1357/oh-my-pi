/**
 * Bearer-token file helpers shared by the auth broker and auth gateway CLIs.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readRegularFileText } from "@oh-my-pi/pi-utils/regular-file";

/**
 * Read a token file; `null` when it is missing or blank. A FIFO, socket or
 * device at the name throws `NotARegularFile` unopened, as an unreadable file throws.
 */
export async function readTokenFile(file: string): Promise<string | null> {
	const trimmed = (await readRegularFileText(file))?.trim() ?? "";
	return trimmed.length > 0 ? trimmed : null;
}

/** Write a token file readable only by the current user. */
export async function writeTokenFile(file: string, token: string): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await fs.writeFile(file, token, { mode: 0o600 });
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
}

/** Generate a random URL-safe bearer token. */
export function generateToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

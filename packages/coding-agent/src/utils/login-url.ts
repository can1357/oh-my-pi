import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";

/**
 * Persist the authorization URL to a file and return its path, or undefined
 * when it could not be written.
 *
 * This is the byte-exact copy path that depends on nothing the terminal may or
 * may not support. A multi-row URL selected out of a full-screen frame carries
 * row breaks and padding, which corrupt `state` and `code_challenge` when the
 * result is pasted into a browser; OSC 52 clipboard writes and OSC 8 hyperlinks
 * are byte-exact but optional terminal features. `cat` of a short path that
 * fits one row works everywhere, including over SSH.
 *
 * One well-known path, overwritten per login. Mode 600: the URL carries only
 * public OAuth parameters, but there is no reason to share them.
 */
export function persistLoginUrl(url: string): string | undefined {
	const path = join(getAgentDir(), "login-url.txt");
	try {
		mkdirSync(getAgentDir(), { recursive: true });
		writeFileSync(path, `${url}\n`, { mode: 0o600 });
		return path;
	} catch (error) {
		logger.warn("Failed to persist login URL", {
			path,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

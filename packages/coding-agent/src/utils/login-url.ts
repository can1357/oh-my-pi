import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { basename, join } from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";

const FILE_PREFIX = "login-url-";
const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * Persist the authorization URL to a per-process file and return its path, or
 * undefined when it could not be written.
 *
 * This is the byte-exact copy path that depends on nothing the terminal may or
 * may not support. A multi-row URL selected out of a full-screen frame carries
 * row breaks and padding, which corrupt `state` and `code_challenge` when the
 * result is pasted into a browser; OSC 52 clipboard writes and OSC 8 hyperlinks
 * are byte-exact but optional terminal features. Reading a short path that fits
 * one row works everywhere, including over SSH.
 *
 * Per-process filename: two omp processes with concurrent OAuth flows would
 * otherwise overwrite each other, and the first panel's advertised command
 * would open the second flow's URL, whose `state` no longer matches. Files
 * from dead processes are removed once they are a day old. Mode 600: the URL
 * carries only public OAuth parameters, but there is no reason to share them.
 */
export function persistLoginUrl(url: string): string | undefined {
	const dir = getAgentDir();
	const path = join(dir, `${FILE_PREFIX}${process.pid}.txt`);
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, `${url}\n`, { mode: 0o600 });
	} catch (error) {
		logger.warn("Failed to persist login URL", {
			path,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
	// Best-effort sweep of siblings left by dead processes.
	try {
		for (const name of readdirSync(dir)) {
			if (!name.startsWith(FILE_PREFIX) || !name.endsWith(".txt") || name === basename(path)) continue;
			const sibling = join(dir, name);
			try {
				if (Date.now() - statSync(sibling).mtimeMs > STALE_MS) unlinkSync(sibling);
			} catch {
				// A sibling that vanished mid-sweep or cannot be statted is not our problem.
			}
		}
	} catch {
		// The write above succeeded; a failed sweep must not cost the copy path.
	}
	return path;
}

/**
 * The command a user runs to print the persisted URL, portable to the shell
 * they are actually in.
 *
 * cmd.exe has no `cat`, so win32 renders `type` (also a PowerShell alias) with
 * the path quoted. POSIX renders `cat` with the home prefix shortened to `~`,
 * which must stay outside quotes to expand, so the path is only quoted (and
 * left absolute) when it contains characters the shell would interpret.
 */
export function loginUrlCopyCommand(filePath: string): string {
	if (process.platform === "win32") return `type "${filePath}"`;
	const home = os.homedir();
	const display = filePath.startsWith(`${home}/`) ? `~${filePath.slice(home.length)}` : filePath;
	return /^[\w@%+=:,./~-]+$/.test(display) ? `cat ${display}` : `cat "${filePath}"`;
}
